//! `{{name}}` templates: no logic, loops or escaping; `{{{{` renders a literal `{{`.

use std::borrow::Borrow;
use std::collections::{BTreeMap, HashMap};
use std::hash::{BuildHasher, Hash};

use crate::error::{Error, Result};

/// What `render` does with a `{{variable}}` that has no value.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum OnMissing {
    /// Return [`Error::MissingVariable`] listing every missing name (default).
    #[default]
    Error,
    /// Leave `{{name}}` in the output, exactly as written.
    Keep,
    /// Replace it with the empty string.
    Empty,
}

/// Values for template variables: implemented for slices and arrays of pairs,
/// `Vec<(K, V)>`, `HashMap` and `BTreeMap` with string-like keys and values.
///
/// ```
/// use std::collections::HashMap;
/// let mut m = HashMap::new();
/// m.insert("name", "Ana");
/// assert_eq!(kyp::render("Hi {{name}}", &m, kyp::OnMissing::Error).unwrap(), "Hi Ana");
/// assert_eq!(kyp::render("Hi {{name}}", &[("name", "Ana")], kyp::OnMissing::Error).unwrap(), "Hi Ana");
/// ```
pub trait Vars {
    /// The value for `name`, if any.
    fn var(&self, name: &str) -> Option<&str>;
}

impl<K: AsRef<str>, V: AsRef<str>> Vars for [(K, V)] {
    fn var(&self, name: &str) -> Option<&str> {
        self.iter().find(|(k, _)| k.as_ref() == name).map(|(_, v)| v.as_ref())
    }
}

impl<K: AsRef<str>, V: AsRef<str>, const N: usize> Vars for [(K, V); N] {
    fn var(&self, name: &str) -> Option<&str> {
        self.as_slice().var(name)
    }
}

impl<K: AsRef<str>, V: AsRef<str>> Vars for Vec<(K, V)> {
    fn var(&self, name: &str) -> Option<&str> {
        self.as_slice().var(name)
    }
}

impl<K, V, S> Vars for HashMap<K, V, S>
where
    K: Borrow<str> + Hash + Eq,
    V: AsRef<str>,
    S: BuildHasher,
{
    fn var(&self, name: &str) -> Option<&str> {
        self.get(name).map(AsRef::as_ref)
    }
}

impl<K: Borrow<str> + Ord, V: AsRef<str>> Vars for BTreeMap<K, V> {
    fn var(&self, name: &str) -> Option<&str> {
        self.get(name).map(AsRef::as_ref)
    }
}

impl<T: Vars + ?Sized> Vars for &T {
    fn var(&self, name: &str) -> Option<&str> {
        (**self).var(name)
    }
}

fn ident_start(c: u8) -> bool {
    c.is_ascii_alphabetic() || c == b'_'
}
fn ident_char(c: u8) -> bool {
    ident_start(c) || c.is_ascii_digit()
}
fn space(c: u8) -> bool {
    c == b' ' || c == b'\t'
}

/// At `t[i..]` == `{{`: parses `{{ name }}`, returning the name range and the index after `}}`.
fn parse_var(t: &[u8], i: usize) -> Option<(usize, usize, usize)> {
    let mut j = i + 2;
    while j < t.len() && space(t[j]) {
        j += 1;
    }
    if j >= t.len() || !ident_start(t[j]) {
        return None;
    }
    let start = j;
    while j < t.len() && ident_char(t[j]) {
        j += 1;
    }
    let end_name = j;
    while j < t.len() && space(t[j]) {
        j += 1;
    }
    if j + 1 >= t.len() || t[j] != b'}' || t[j + 1] != b'}' {
        return None;
    }
    Some((start, end_name, j + 2))
}

enum Piece<'a> {
    Lit(&'a str),
    Var { name: &'a str, raw: &'a str },
}

/// Walks the template, calling `f` with literal text and variables in order.
fn scan<'a>(t: &'a str, mut f: impl FnMut(Piece<'a>)) {
    let b = t.as_bytes();
    let (mut i, mut run) = (0usize, 0usize);
    while i < b.len() {
        let Some(off) = t[i..].find("{{") else { break };
        let open = i + off;
        if b[open..].starts_with(b"{{{{") {
            f(Piece::Lit(&t[run..open]));
            f(Piece::Lit("{{"));
            i = open + 4;
            run = i;
            continue;
        }
        if let Some((s, e, end)) = parse_var(b, open) {
            f(Piece::Lit(&t[run..open]));
            f(Piece::Var { name: &t[s..e], raw: &t[open..end] });
            i = end;
            run = end;
        } else {
            i = open + 2; // not a variable: keep the braces as text
        }
    }
    f(Piece::Lit(&t[run..]));
}

/// Renders `tmpl`: each `{{name}}` is replaced by its value (values are not rendered again).
pub fn render<V: Vars + ?Sized>(tmpl: &str, vars: &V, on_missing: OnMissing) -> Result<String> {
    let mut out = String::with_capacity(tmpl.len() + 64);
    let mut missing: Vec<String> = Vec::new();
    scan(tmpl, |piece| match piece {
        Piece::Lit(s) => out.push_str(s),
        Piece::Var { name, raw } => match vars.var(name) {
            Some(v) => out.push_str(v),
            None => match on_missing {
                OnMissing::Keep => out.push_str(raw),
                OnMissing::Empty => {}
                OnMissing::Error => {
                    if !missing.iter().any(|m| m == name) {
                        missing.push(name.to_owned());
                    }
                }
            },
        },
    });
    if missing.is_empty() {
        Ok(out)
    } else {
        Err(Error::MissingVariable { names: missing })
    }
}

/// Distinct variable names in order of first appearance.
pub fn variables_in(tmpl: &str) -> Vec<String> {
    let mut names: Vec<String> = Vec::new();
    scan(tmpl, |piece| {
        if let Piece::Var { name, .. } = piece {
            if !names.iter().any(|n| n == name) {
                names.push(name.to_owned());
            }
        }
    });
    names
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn edge_cases() {
        let none: [(&str, &str); 0] = [];
        assert_eq!(render("{{", &none, OnMissing::Error).unwrap(), "{{");
        assert_eq!(render("{{a", &none, OnMissing::Error).unwrap(), "{{a");
        assert_eq!(render("{{{a}}", &[("a", "x")], OnMissing::Error).unwrap(), "{{{a}}");
        assert_eq!(render("a}}b", &none, OnMissing::Error).unwrap(), "a}}b");
        assert_eq!(render("{{\ta\t}}", &[("a", "x")], OnMissing::Error).unwrap(), "x");
        assert_eq!(render("{{a}}{{b}}", &none, OnMissing::Empty).unwrap(), "");
        let e = render("{{b}}{{a}}{{b}}", &none, OnMissing::Error).unwrap_err();
        assert_eq!(e, Error::MissingVariable { names: vec!["b".into(), "a".into()] });
        assert_eq!(e.to_string(), "missing template variables: b, a");
    }
}
