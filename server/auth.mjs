import express from "express";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse
} from "@simplewebauthn/server";
import { SignJWT, jwtVerify } from "jose";
import {
  listPasskeys,
  savePasskey,
  updatePasskeyCounter,
  deletePasskey,
  passkeyCount
} from "./database.mjs";

const RP_ID = process.env.WEBAUTHN_RP_ID || "localhost";
const RP_ORIGIN = process.env.WEBAUTHN_RP_ORIGIN || "http://localhost:8000";
const RP_NAME = process.env.WEBAUTHN_RP_NAME || "Task Tracker";

function resolveJwtSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  const secretFile = resolve(dirname(fileURLToPath(import.meta.url)), "../data/jwt-secret.local");
  try {
    return readFileSync(secretFile, "utf8").trim();
  } catch {
    const generated = randomBytes(32).toString("hex");
    mkdirSync(dirname(secretFile), { recursive: true });
    writeFileSync(secretFile, generated, { mode: 0o600 });
    console.log("Generated JWT secret saved to", secretFile);
    return generated;
  }
}

const SECRET = new TextEncoder().encode(resolveJwtSecret());

// In-memory challenge store — single user, 90s TTL
let pendingChallenge = null;

function storeChallenge(value) {
  pendingChallenge = { value, expiresAt: Date.now() + 90_000 };
}

function consumeChallenge() {
  if (!pendingChallenge || Date.now() > pendingChallenge.expiresAt) {
    pendingChallenge = null;
    return null;
  }
  const value = pendingChallenge.value;
  pendingChallenge = null;
  return value;
}

async function issueJwt() {
  return new SignJWT({ sub: "owner" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("8h")
    .sign(SECRET);
}

async function verifyJwt(token) {
  const { payload } = await jwtVerify(token, SECRET, { algorithms: ["HS256"] });
  return payload;
}

function setSessionCookie(res, token) {
  res.cookie("session", token, {
    httpOnly: true,
    sameSite: "strict",
    secure: RP_ORIGIN.startsWith("https"),
    maxAge: 8 * 3600 * 1000
  });
}

export async function requireAuth(req, res, next) {
  const token = req.cookies?.session;
  if (!token) {
    res.status(401).json({ error: "Not authenticated." });
    return;
  }
  try {
    await verifyJwt(token);
    next();
  } catch {
    res.clearCookie("session");
    res.status(401).json({ error: "Session expired." });
  }
}

export function createAuthRouter(db) {
  const router = express.Router();

  // GET /api/auth/status
  router.get("/api/auth/status", async (req, res) => {
    const token = req.cookies?.session;
    let authenticated = false;
    if (token) {
      try { await verifyJwt(token); authenticated = true; } catch { /* expired */ }
    }
    res.json({ authenticated, bootstrapMode: passkeyCount(db) === 0 });
  });

  // POST /api/auth/register/options
  router.post("/api/auth/register/options", async (req, res) => {
    // Require auth if passkeys already exist (not bootstrap mode)
    if (passkeyCount(db) > 0) {
      const token = req.cookies?.session;
      if (!token) { res.status(401).json({ error: "Not authenticated." }); return; }
      try { await verifyJwt(token); } catch { res.clearCookie("session"); res.status(401).json({ error: "Session expired." }); return; }
    }

    const existing = listPasskeys(db);
    const options = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID: RP_ID,
      userName: "owner",
      userDisplayName: "Owner",
      attestationType: "none",
      excludeCredentials: existing.map((p) => ({
        id: p.id,
        transports: JSON.parse(p.transports || "[]")
      })),
      authenticatorSelection: {
        residentKey: "required",
        userVerification: "required"
      }
    });

    storeChallenge(options.challenge);
    res.json(options);
  });

  // POST /api/auth/register/verify
  router.post("/api/auth/register/verify", async (req, res) => {
    if (passkeyCount(db) > 0) {
      const token = req.cookies?.session;
      if (!token) { res.status(401).json({ error: "Not authenticated." }); return; }
      try { await verifyJwt(token); } catch { res.clearCookie("session"); res.status(401).json({ error: "Session expired." }); return; }
    }

    const expectedChallenge = consumeChallenge();
    if (!expectedChallenge) {
      res.status(400).json({ error: "Challenge expired. Please try again." });
      return;
    }

    const { passkeyName, ...credentialResponse } = req.body;

    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response: credentialResponse,
        expectedChallenge,
        expectedOrigin: RP_ORIGIN,
        expectedRPID: RP_ID,
        requireUserVerification: true
      });
    } catch (err) {
      res.status(400).json({ error: err.message || "Registration verification failed." });
      return;
    }

    if (!verification.verified || !verification.registrationInfo) {
      res.status(400).json({ error: "Registration failed." });
      return;
    }

    const { credential } = verification.registrationInfo;
    savePasskey(db, {
      id: credential.id,
      public_key: Buffer.from(credential.publicKey).toString("base64url"),
      counter: credential.counter,
      transports: JSON.stringify(credentialResponse.response?.transports ?? []),
      name: (typeof passkeyName === "string" && passkeyName.trim()) ? passkeyName.trim() : "Passkey",
      created_at: new Date().toISOString()
    });

    const token = await issueJwt();
    setSessionCookie(res, token);
    res.json({ verified: true });
  });

  // POST /api/auth/authenticate/options
  router.post("/api/auth/authenticate/options", async (_req, res) => {
    const options = await generateAuthenticationOptions({
      rpID: RP_ID,
      userVerification: "required",
      allowCredentials: []
    });
    storeChallenge(options.challenge);
    res.json(options);
  });

  // POST /api/auth/authenticate/verify
  router.post("/api/auth/authenticate/verify", async (req, res) => {
    const credentialId = req.body.id;
    const passkey = listPasskeys(db).find((p) => p.id === credentialId);
    if (!passkey) {
      res.status(400).json({ error: "Unknown credential." });
      return;
    }

    const expectedChallenge = consumeChallenge();
    if (!expectedChallenge) {
      res.status(400).json({ error: "Challenge expired. Please try again." });
      return;
    }

    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response: req.body,
        expectedChallenge,
        expectedOrigin: RP_ORIGIN,
        expectedRPID: RP_ID,
        credential: {
          id: passkey.id,
          publicKey: Buffer.from(passkey.public_key, "base64url"),
          counter: passkey.counter,
          transports: JSON.parse(passkey.transports || "[]")
        },
        requireUserVerification: true
      });
    } catch (err) {
      res.status(401).json({ error: err.message || "Authentication failed." });
      return;
    }

    if (!verification.verified) {
      res.status(401).json({ error: "Authentication failed." });
      return;
    }

    updatePasskeyCounter(db, credentialId, verification.authenticationInfo.newCounter);

    const token = await issueJwt();
    setSessionCookie(res, token);
    res.json({ verified: true });
  });

  // POST /api/auth/logout
  router.post("/api/auth/logout", (_req, res) => {
    res.clearCookie("session");
    res.json({ ok: true });
  });

  // GET /api/auth/passkeys
  router.get("/api/auth/passkeys", requireAuth, (req, res) => {
    const passkeys = listPasskeys(db).map((p) => ({
      id: p.id,
      name: p.name,
      createdAt: p.created_at,
      transports: JSON.parse(p.transports || "[]")
    }));
    res.json(passkeys);
  });

  // DELETE /api/auth/passkeys/:id
  router.delete("/api/auth/passkeys/:id", requireAuth, (req, res) => {
    if (passkeyCount(db) <= 1) {
      res.status(409).json({ error: "Cannot delete the only passkey." });
      return;
    }
    deletePasskey(db, req.params.id);
    res.json({ ok: true });
  });

  return router;
}
