import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

// Refreshes the Supabase auth session cookie on each request (live mode only).
// Authorization itself is enforced in server code and database RLS, not here.
export async function proxy(request: NextRequest) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (process.env.APP_MODE === "demo" || !url || !key) return NextResponse.next();

  let response = NextResponse.next({ request });
  const supabase = createServerClient(url, key, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (list) => {
        for (const { name, value } of list) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const { name, value, options } of list) response.cookies.set(name, value, options);
      },
    },
  });
  await supabase.auth.getUser();
  return response;
}

export const config = {
  // The WhatsApp webhook and scheduled dispatch carry no user session; they check their own secrets.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icon|manifest.webmanifest|api/whatsapp/webhook|api/whatsapp/dispatch|.*\\.(?:svg|png|jpg|jpeg|webp)$).*)"],
};
