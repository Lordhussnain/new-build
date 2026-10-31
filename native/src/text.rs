use serde_json::Value;

/// ECMAScript WhiteSpace + LineTerminator code points used by String#trim.
pub fn is_js_whitespace(c: char) -> bool {
    matches!(
        c,
        '\u{0009}'
            | '\u{000a}'
            | '\u{000b}'
            | '\u{000c}'
            | '\u{000d}'
            | '\u{0020}'
            | '\u{00a0}'
            | '\u{1680}'
            | '\u{2000}'
            | '\u{2001}'
            | '\u{2002}'
            | '\u{2003}'
            | '\u{2004}'
            | '\u{2005}'
            | '\u{2006}'
            | '\u{2007}'
            | '\u{2008}'
            | '\u{2009}'
            | '\u{200a}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202f}'
            | '\u{205f}'
            | '\u{3000}'
            | '\u{feff}'
    )
}

pub fn js_trim(value: &str) -> &str {
    value.trim_matches(is_js_whitespace)
}

/// String(value) for JSON-representable values. Exotic JS values are handled
/// by the TypeScript compatibility path and never cross the native boundary.
pub fn js_string(value: &Value) -> String {
    match value {
        Value::Null => "null".to_string(),
        Value::Bool(value) => value.to_string(),
        Value::Number(value) => value.to_string(),
        Value::String(value) => value.clone(),
        Value::Array(values) => values
            .iter()
            .map(|value| {
                if value.is_null() {
                    String::new()
                } else {
                    js_string(value)
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".to_string(),
    }
}

/// Number(String(value).trim()) for settings form values.
pub fn js_number(value: &Value) -> Option<f64> {
    if let Value::Number(number) = value {
        return number.as_f64().filter(|number| number.is_finite());
    }
    let text = js_trim(&js_string(value));
    if text.is_empty() {
        return None;
    }
    let parsed = if let Some(hex) = text.strip_prefix("0x").or_else(|| text.strip_prefix("0X")) {
        u128::from_str_radix(hex, 16)
            .ok()
            .map(|number| number as f64)
    } else if let Some(binary) = text.strip_prefix("0b").or_else(|| text.strip_prefix("0B")) {
        u128::from_str_radix(binary, 2)
            .ok()
            .map(|number| number as f64)
    } else if let Some(octal) = text.strip_prefix("0o").or_else(|| text.strip_prefix("0O")) {
        u128::from_str_radix(octal, 8)
            .ok()
            .map(|number| number as f64)
    } else {
        text.parse::<f64>().ok()
    };
    parsed.filter(|number| number.is_finite())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn matches_javascript_trim_and_string_forms() {
        assert_eq!(js_trim("\u{feff}  value\n"), "value");
        assert_eq!(js_string(&json!(["en", null, "ja"])), "en,,ja");
        assert_eq!(js_string(&json!({"x": 1})), "[object Object]");
    }

    #[test]
    fn accepts_javascript_number_syntax_but_not_non_finite_values() {
        assert_eq!(js_number(&json!("0x10")), Some(16.0));
        assert_eq!(js_number(&json!(" 1.5e1 ")), Some(15.0));
        assert_eq!(js_number(&json!("Infinity")), None);
        assert_eq!(js_number(&json!("")), None);
    }
}
