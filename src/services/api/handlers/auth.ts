import type { IncomingMessage, ServerResponse } from "node:http";
import {
  verifyPassword,
  createAdminSession,
  revokeAdminSession,
  getAdminSession,
  DUMMY_PASSWORD_HASH,
} from "@/services/auth/index.js";
import { readJsonBody, sendJson, sendValidationError } from "../http.js";
import { z } from "zod";
import { type Deps } from "./shared.js";

export function createAuthHandlers(deps: Deps) {
  async function login(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!deps.adminUserRepo) {
      sendJson(res, 500, {
        error: "internal_error",
        message: "Admin user repository not initialized",
      });
      return;
    }

    const body = await readJsonBody(req);
    const parsed = z
      .object({
        identifier: z.string().min(1, "Identifier (email or username) is required"),
        password: z.string().min(1, "Password is required"),
      })
      .safeParse(body);

    if (!parsed.success) {
      sendValidationError(res, parsed.error);
      return;
    }

    const { identifier, password } = parsed.data;
    const user = await deps.adminUserRepo.findByEmailOrUsername(identifier);
    const targetHash = user ? user.passwordHash : DUMMY_PASSWORD_HASH;
    let isValid = await verifyPassword(password, targetHash);
    // The startup admin's ADMIN_PASSWORD is stored trimmed (a Windows `set`
    // leaves a trailing space in it), so one configured with spaces at either
    // end would otherwise never match what is typed. Only a failed attempt
    // with such spaces pays the second check.
    if (!isValid && password.trim() !== password && password.trim()) {
      isValid = await verifyPassword(password.trim(), targetHash);
    }
    if (!user || !isValid) {
      sendJson(res, 401, { error: "unauthorized", message: "Invalid credentials" });
      return;
    }

    const session = await createAdminSession(deps.redis.native, user);
    sendJson(res, 200, {
      token: session.token,
      user: {
        id: user.id,
        email: user.email,
        username: user.username,
        role: user.role,
      },
      expiresAt: session.expiresAt,
    });
  }

  async function logout(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const authHeader = req.headers["authorization"];
    let token: string | undefined;
    if (typeof authHeader === "string" && authHeader.toLowerCase().startsWith("bearer ")) {
      token = authHeader.slice(7).trim();
    }
    if (token) {
      await revokeAdminSession(deps.redis.native, token);
    }
    sendJson(res, 200, { message: "Logged out successfully" });
  }

  async function getMe(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const authHeader = req.headers["authorization"];
    let token: string | undefined;
    if (typeof authHeader === "string" && authHeader.toLowerCase().startsWith("bearer ")) {
      token = authHeader.slice(7).trim();
    }
    if (!token) {
      sendJson(res, 401, { error: "unauthorized", message: "Missing token" });
      return;
    }

    const session = await getAdminSession(deps.redis.native, token);
    if (!session) {
      sendJson(res, 401, { error: "unauthorized", message: "Invalid or expired session" });
      return;
    }

    sendJson(res, 200, {
      user: {
        id: session.adminId,
        email: session.email,
        username: session.username,
        role: session.role,
      },
    });
  }

  return {
    login,
    logout,
    getMe,
  };
}
