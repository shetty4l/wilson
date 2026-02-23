/**
 * Wilson SQLite database.
 *
 * Stores persistent channel state that survives restarts.
 * Location: ~/.local/share/wilson/wilson.db (XDG compliant)
 */

import { getDataDir } from "@shetty4l/core/config";
import { createDatabaseManager } from "@shetty4l/core/db";
import { join } from "path";

export const dbManager = createDatabaseManager({
  path: join(getDataDir("wilson"), "wilson.db"),
});
