#!/usr/bin/env node
import { main } from "./cli.mjs";

const { code, server } = await main(process.argv.slice(2), process.env);
if (code !== null) process.exit(code);
const stop = async () => {
  await server.close();
  process.exit(0);
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
