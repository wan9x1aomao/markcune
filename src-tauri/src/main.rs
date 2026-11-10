#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Android starts through the `mobile_entry_point` on `run` inside the cdylib.
    // Desktop still enters here and runs the same function.
    mdpad_lib::run();
}
