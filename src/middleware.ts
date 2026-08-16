/**
 * Edge middleware — coarse route protection (§4, §35).
 *
 * This performs a *presence* check on the session cookie only. It cannot query
 * Postgres (edge runtime), so it must not be treated as authorisation: every API
 * route and server component still calls `requireUser()`, which validates the
 * session against the database. The purpose here is to avoid rendering the
 * dashboard shell for an obviously-unauthenticated visitor and to send signed-in
 * users away from the marketing and auth pages.
 */
import { NextResponse, type NextRequest } from "next/server";

const SESSION_COOKIE = "tally_session";

/** Paths that require a session cookie to be present. */
const PROTECTED_PREFIXES = ["/dashboard", "/onboarding", "/plan"];

/** Auth pages a signed-in user should not see. */
const AUTH_PAGES = ["/login", "/signup", "/forgot-password"];

export function middleware(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const hasSession = Boolean(request.cookies.get(SESSION_COOKIE)?.value);

  if (PROTECTED_PREFIXES.some((p) => pathname.startsWith(p)) && !hasSession) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    // Preserve the intended destination so login can return the user to it.
    url.search = `?next=${encodeURIComponent(pathname + search)}`;
    return NextResponse.redirect(url);
  }

  if (AUTH_PAGES.includes(pathname) && hasSession) {
    const url = request.nextUrl.clone();
    url.pathname = "/dashboard";
    url.search = "";
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  // Exclude API routes (they authenticate themselves and must return JSON 401s,
  // not redirects), Next internals, and static assets.
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|.*\\.).*)"],
};
