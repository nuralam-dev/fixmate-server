// BetterAuth owns cookie signatures, session expiry and the current database user.
// This middleware deliberately does not accept an opaque session as a JWT.
export async function verifyToken(req, res, next) {
  res.setHeader("Cache-Control", "private, no-store");
  const cookie = req.headers.cookie;
  if (!cookie) {
    return res.status(401).json({ success: false, message: "Authentication required" });
  }

  try {
    // This URL is server configuration, never derived from request headers/input.
    const authOrigin = process.env.BETTER_AUTH_URL || process.env.CLIENT_URL
      || (process.env.NODE_ENV !== "production" ? "http://localhost:3000" : "");
    const url = new URL("/api/auth/get-session", authOrigin);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && process.env.NODE_ENV !== "production")) {
      throw new Error("A secure BetterAuth origin is required");
    }
    url.searchParams.set("disableCookieCache", "true");
    url.searchParams.set("disableRefresh", "true");
    const response = await fetch(url, {
      headers: { Cookie: cookie, Accept: "application/json" },
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(8000),
    });
    if (response.status === 401) {
      return res.status(401).json({ success: false, message: "Invalid or expired session" });
    }
    if (!response.ok) throw new Error("Session verification unavailable");
    const result = await response.json();
    const user = result?.user;
    const session = result?.session;
    if (!session || !user || typeof user.id !== "string" || !user.id
      || session.userId !== user.id || typeof user.email !== "string" || !user.email
      || typeof user.name !== "string" || !user.name.trim()
      || !Number.isFinite(Date.parse(session.expiresAt))
      || Date.parse(session.expiresAt) <= Date.now()) {
      return res.status(401).json({ success: false, message: "Invalid or expired session" });
    }
    req.user = { id: user.id, name: user.name, email: user.email, role: user.role };
    next();
  } catch {
    // A failed auth service never authorizes a request or exposes its response.
    res.status(503).json({ success: false, message: "Authentication verification is temporarily unavailable" });
  }
}
