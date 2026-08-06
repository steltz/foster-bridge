export const ARCHIVE_URL = 'https://www.eminiplayer.net/archive.aspx';
export const LOGIN_URL = 'https://www.eminiplayer.net/login.aspx';

// Selectors verified against the live site 2026-08-06 (BlogEngine.NET /
// ASP.NET WebForms markup). The nav reuses ONE anchor (#ctl00_aLogin) for
// both states: "Member Login" -> /login.aspx when logged out, "Log off" ->
// /login.aspx?logoff when logged in. So the logged-out signal is that
// anchor without the logoff query. Both halves matter: matching any
// login.aspx href would report logged-out forever (the nav's "Log off"
// link), and dropping the :not() would do the same via the members-only
// "Change password" link, which also points at /login.aspx.
export const SELECTORS = {
  loginLink: 'a#ctl00_aLogin:not([href*="logoff"])',
  username: '#ctl00_cphBody_Login1_UserName',
  password: '#ctl00_cphBody_Login1_Password',
  submit: '#ctl00_cphBody_Login1_LoginButton',
} as const;

export interface ArchivePageResult {
  url: string;
  title: string;
  screenshotPath: string;
}
