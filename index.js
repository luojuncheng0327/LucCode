#!/usr/bin/env node
import { main } from "./cli/entry.ts";

const code = await main(process.argv.slice(2));
if (code) process.exit(code);
