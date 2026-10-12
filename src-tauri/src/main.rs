#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Started as `BROWSER` by a per-account login: open the URL in Chrome and exit.
    if alethe_lib::login_browser_shim() {
        return;
    }
    alethe_lib::run()
}
