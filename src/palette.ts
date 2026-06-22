import palette from "../palette.json";
import type { CSSProperties } from "react";
import type { ThemeMode } from "./types";

type Palette = typeof palette;

export function themeVars(mode: ThemeMode): CSSProperties {
  const colors = (palette as Palette)[mode === "dark" ? "dark_mode" : "light_mode"].color;
  return {
    "--color-scheme": mode,
    "--background-app": colors.background.app,
    "--background-surface": colors.background.surface,
    "--background-surface-elevated": colors.background.surfaceElevated,
    "--background-surface-hover": colors.background.surfaceHover,
    "--background-surface-pressed": colors.background.surfacePressed,
    "--foreground-primary": colors.foreground.primary,
    "--foreground-secondary": colors.foreground.secondary,
    "--foreground-tertiary": colors.foreground.tertiary,
    "--foreground-disabled": colors.foreground.disabled,
    "--foreground-inverse": colors.foreground.inverse,
    "--border-subtle": colors.border.subtle,
    "--border-default": colors.border.default,
    "--border-strong": colors.border.strong,
    "--border-focus": colors.border.focus,
    "--tile-default": colors.tile.default,
    "--tile-alternate": colors.tile.alternate,
    "--tile-active": colors.tile.active,
    "--tile-completed": colors.tile.completed,
    "--tile-overdue": colors.tile.overdue,
    "--status-red-bar": colors.status.red.bar,
    "--status-red-background": colors.status.red.background,
    "--status-red-text": colors.status.red.text,
    "--status-yellow-bar": colors.status.yellow.bar,
    "--status-yellow-background": colors.status.yellow.background,
    "--status-yellow-text": colors.status.yellow.text,
    "--status-green-bar": colors.status.green.bar,
    "--status-green-background": colors.status.green.background,
    "--status-green-text": colors.status.green.text,
    "--button-primary-background": colors.button.primary.background,
    "--button-primary-background-hover": colors.button.primary.backgroundHover,
    "--button-primary-text": colors.button.primary.text,
    "--button-secondary-background": colors.button.secondary.background,
    "--button-secondary-background-hover": colors.button.secondary.backgroundHover,
    "--button-secondary-text": colors.button.secondary.text,
    "--button-danger-background": colors.button.danger.background,
    "--button-danger-background-hover": colors.button.danger.backgroundHover,
    "--button-danger-text": colors.button.danger.text,
    "--input-background": colors.input.background,
    "--input-border": colors.input.border,
    "--input-border-focus": colors.input.borderFocus,
    "--input-placeholder": colors.input.placeholder,
    "--input-text": colors.input.text,
    "--accent-brand": colors.accent.brand,
    "--accent-brand-soft": colors.accent.brandSoft,
    "--shadow-default": colors.shadow.default,
    "--shadow-strong": colors.shadow.strong
  } as CSSProperties;
}
