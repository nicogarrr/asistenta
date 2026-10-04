/**
 * Tests that drive the real Windows stack (PowerShell, System.Drawing, WinRT OCR) cannot
 * run anywhere else: `spawn powershell.exe` fails with EACCES/ENOENT on Linux and macOS,
 * which is not a bug in the code under test. They are skipped there, visibly, instead of
 * failing on every run and teaching everyone to ignore a red suite.
 *
 * On Windows they run for real; the CI workflow has a manual Windows job for that.
 */
export const isWindows = process.platform === 'win32';
