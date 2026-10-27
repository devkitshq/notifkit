import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { useInfra } from "./support/infra.js";
import { apiClient, startNotifkit, type Running } from "./support/pipeline.js";

/**
 * The dashboard user created at startup from ADMIN_EMAIL / ADMIN_PASSWORD. A
 * file of its own because the server reads them once per process.
 */

const infra = useInfra();
let app: Running;
const PASSWORD = "  correct horse battery  ";

beforeAll(async () => {
  app = await startNotifkit(infra, {
    services: ["api"],
    env: { ADMIN_EMAIL: "boot@example.com", ADMIN_PASSWORD: PASSWORD },
  });
}, 120_000);

afterAll(async () => {
  await app?.stop();
}, 60_000);

describe("the startup admin user", () => {
  it("signs in with the password exactly as configured, spaces included", async () => {
    // It used to be saved trimmed, while login compares what is typed as is,
    // so a password with a leading or trailing space could never sign in.
    const login = await apiClient(app.baseUrl)("POST", "/v1/auth/login", {
      identifier: "boot@example.com",
      password: PASSWORD,
    });
    expect(login.status).toBe(200);
  });

  it("signs in without the surrounding spaces too, as a Windows `set` adds them by accident", async () => {
    const login = await apiClient(app.baseUrl)("POST", "/v1/auth/login", {
      identifier: "boot@example.com",
      password: PASSWORD.trim(),
    });
    expect(login.status).toBe(200);
  });

  it("still refuses a wrong password, spaces or not", async () => {
    for (const password of ["  wrong horse  ", "wrong horse"]) {
      const login = await apiClient(app.baseUrl)("POST", "/v1/auth/login", {
        identifier: "boot@example.com",
        password,
      });
      expect(login.status).toBe(401);
    }
  });
});
