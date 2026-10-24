import { NextResponse } from "next/server";

// Adds browser security headers to every page and API response. Sessions need no
// refreshing here: the session cookie is checked against the database per request.
export function proxy() {
  const response = NextResponse.next();
  const h = response.headers;
  h.set("X-Content-Type-Options", "nosniff");
  h.set("X-Frame-Options", "DENY");
  h.set("Referrer-Policy", "strict-origin-when-cross-origin");
  h.set("Permissions-Policy", "geolocation=(), microphone=(), camera=(), payment=()");
  if (process.env.APP_MODE === "production" || process.env.APP_MODE === "live") {
    h.set("Strict-Transport-Security", "max-age=31536000");
  }
  return response;
}

export const config = {
  // The WhatsApp webhook and scheduled dispatch carry no user session; they check their own secrets.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icon|manifest.webmanifest|api/whatsapp/webhook|api/whatsapp/dispatch|.*\\.(?:svg|png|jpg|jpeg|webp)$).*)"],
};
