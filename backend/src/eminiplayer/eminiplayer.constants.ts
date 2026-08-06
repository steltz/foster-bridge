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

/** One row of the archive listing, date normalized to MMDDYYYY. */
export interface ArchiveEntry {
  date: string;
  pageUrl: string;
  title: string;
}

/**
 * The two archive entries an ingest run needs: the trade plan for the
 * requested date and the most recent recap dated strictly before it.
 */
export interface DayEntries {
  tradePlan: ArchiveEntry;
  recap: ArchiveEntry;
}

/**
 * The archive doesn't have what was asked for: no TP entry for the date, or
 * no recap entry within the recap search window before it (the recap scan is
 * bounded to RECAP_LOOKBACK_DAYS calendar days so a bad historical date can't
 * force a whole-archive walk inside one withPage callback). Owned by the
 * scraper layer — findDayEntries throws it once selectors land; the ingest
 * layer passes it through untouched and the controller maps it to HTTP 404.
 */
export class ArchiveNotFoundError extends Error {}

/** Bound for the backwards recap scan in findDayEntries. */
export const RECAP_LOOKBACK_DAYS = 14;

/** Stamped into every manifest; bump when pipeline behavior changes. */
export const INGEST_PIPELINE_VERSION = 1;
