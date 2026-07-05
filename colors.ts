// ANSI colors — thin wrapper over @std/fmt/colors. The std helpers respect
// NO_COLOR but not whether stdout is a TTY, so applyColorPreference() gates
// them on both (matching the old behavior: no color when piped).

import {
  bold,
  cyan,
  dim,
  gray,
  green,
  red,
  setColorEnabled,
  yellow,
} from "jsr:@std/fmt@1/colors";

// grey: British spelling used throughout the app.
const grey = gray;

export { bold, cyan, dim, green, grey, red, yellow };

// Disable color when stdout isn't a terminal or NO_COLOR is set.
export function applyColorPreference(): void {
  setColorEnabled(Deno.stdout.isTerminal() && !Deno.env.get("NO_COLOR"));
}

export function die(msg: string): never {
  console.error(red(msg));
  Deno.exit(1);
}
