import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["Noto Sans", "sans-serif"]
      },
      borderRadius: {
        app: "8px"
      }
    }
  },
  plugins: []
} satisfies Config;
