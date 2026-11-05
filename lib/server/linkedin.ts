export function linkedinUsername(url: string): string | null {
  const m = url.toLowerCase().match(/\/in\/([^/?#]+)/);
  try {
    const username = m ? decodeURIComponent(m[1]).trim().toLowerCase() : "";
    return /^[\p{L}\p{N}\p{M}._-]{1,200}$/u.test(username) ? username : null;
  } catch {
    return null;
  }
}
