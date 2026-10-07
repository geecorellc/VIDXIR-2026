import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";

it("can import and run liveness before production secrets are configured", () => {
  const variables: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: "production", EMAIL_PROVIDER: "resend", APP_URL: "https://app.vidxir.com",
    VIDXIR_USE_MOCK_PROVIDERS: "false", VIDXIR_BLOCK_REAL_PUBLISH: "false" };
  delete variables.ENCRYPTION_KEY;
  delete variables.SESSION_SECRET;
  const output = execFileSync(process.execPath, ["--input-type=module", "--import", "tsx", "-e",
    "const {liveness}=await import('./src/lib/health.ts'); console.log(JSON.stringify(liveness()));"], {
    cwd: process.cwd(), env: variables, encoding: "utf8", timeout: 10000,
  });
  expect(JSON.parse(output)).toMatchObject({ status: "ok" });
});
