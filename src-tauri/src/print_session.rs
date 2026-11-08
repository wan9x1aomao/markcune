//! Which window is in a native print panel. One session per window, so two windows can print
//! without one finishing the other.

use std::collections::HashSet;
#[cfg(target_os = "macos")]
use std::sync::{LazyLock, Mutex};

#[derive(Default)]
pub struct PrintBook {
    labels: HashSet<String>,
}

impl PrintBook {
    pub fn begin(&mut self, label: &str) -> bool {
        self.labels.insert(label.to_string())
    }

    pub fn end(&mut self, label: &str) -> bool {
        self.labels.remove(label)
    }

    pub fn contains(&self, label: &str) -> bool {
        self.labels.contains(label)
    }
}

#[cfg(target_os = "macos")]
fn book() -> &'static Mutex<PrintBook> {
    static BOOK: LazyLock<Mutex<PrintBook>> = LazyLock::new(|| Mutex::new(PrintBook::default()));
    &BOOK
}

#[cfg(target_os = "macos")]
pub fn begin(label: &str) -> bool {
    book().lock().unwrap().begin(label)
}

#[cfg(target_os = "macos")]
pub fn end(label: &str) -> bool {
    book().lock().unwrap().end(label)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn two_windows_have_separate_print_sessions() {
        let mut book = PrintBook::default();
        assert!(book.begin("doc-1"));
        assert!(book.begin("doc-2"));
        assert!(!book.begin("doc-1"), "the same window cannot start a second panel");
        assert!(book.end("doc-1"));
        assert!(!book.contains("doc-1"));
        assert!(book.contains("doc-2"));
        assert!(book.begin("doc-1"));
    }
}
