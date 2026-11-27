using System.Text;
using System.Text.RegularExpressions;

namespace Jellyfin.Plugin.HeraTv;

/// <summary>
/// Gates a stylesheet behind a class on <c>&lt;html&gt;</c>: every rule applies only while the class is
/// there, so Hera's styling follows its scripts. The core stylesheets sit behind <c>hera-on</c>, which
/// the core script removes in safe mode; each module's behind <c>hera-m-&lt;module&gt;</c>, which core
/// removes while the module stands aside or is switched off. A Jellyfin update that breaks a module
/// then takes only that module's styling away, instead of leaving it half-drawn on a page Hera no
/// longer understands.
/// </summary>
/// <remarks>
/// The class alone is added, with no type selector, so every rule gains the same specificity
/// (one class) and the order in which rules beat each other is unchanged. A selector starting at
/// <c>html</c> or <c>:root</c> (or at <c>*</c>, a pseudo-element, or a class or attribute Hera or
/// Jellyfin sets on <c>&lt;html&gt;</c>) has the class merged into that compound, because the element it
/// describes is the one carrying the class; the last three also get the descendant form. Grouping
/// at-rules (<c>@media</c>, <c>@supports</c>, <c>@layer</c>, <c>@container</c>) are entered; everything
/// else with a block (<c>@keyframes</c>, <c>@font-face</c>, <c>@property</c>) is copied as it is. Rule
/// bodies are copied untouched, so native nesting needs no handling: a nested rule hangs off a
/// selector that has been gated.
/// </remarks>
internal static partial class CssGate
{
    private static readonly string[] Grouping = ["media", "supports", "layer", "container", "document", "starting-style"];

    // Classes and attributes that Jellyfin or Hera's core put on <html>: a compound that leads with
    // one of them may describe <html> itself. A new one belongs in this list.
    [GeneratedRegex(@"\.layout-[\w-]+|\.hera-(?:home|art-top|scrolled|view-taken|signed-out|search-open|osd-up|postplay-on|postplay-focus|stock-hidden)(?![\w-])|\[data-hera-(?:scheme|view|taken)")]
    private static partial Regex RootState();

    /// <summary>Returns <paramref name="css"/> with every rule gated behind the class <paramref name="gate"/> on <c>&lt;html&gt;</c>.</summary>
    public static string Apply(string css, string gate)
    {
        var output = new StringBuilder(css.Length + css.Length / 8);
        Walk(css, 0, css.Length, gate, output);
        return output.ToString();
    }

    private static void Walk(string css, int start, int end, string gate, StringBuilder output)
    {
        var i = start;
        while (i < end)
        {
            if (char.IsWhiteSpace(css[i]))
            {
                output.Append(css[i++]);
                continue;
            }

            if (IsCommentAt(css, i, end))
            {
                var after = CommentEnd(css, i, end);
                output.Append(css, i, after - i);
                i = after;
                continue;
            }

            var open = PreludeEnd(css, i, end);
            if (open >= end || css[open] == '}')
            {
                output.Append(css, i, end - i);
                return;
            }

            if (css[open] == ';')
            {
                // A statement at-rule (@import, @charset, @layer a, b;): nothing to gate.
                output.Append(css, i, open + 1 - i);
                i = open + 1;
                continue;
            }

            var close = BlockEnd(css, open, end);
            var prelude = StripComments(css.AsSpan(i, open - i)).Trim();
            if (prelude.StartsWith('@'))
            {
                output.Append(css, i, open + 1 - i);
                if (Grouping.Contains(AtName(prelude), StringComparer.Ordinal))
                {
                    Walk(css, open + 1, close, gate, output);
                }
                else
                {
                    output.Append(css, open + 1, close - open - 1);
                }
            }
            else
            {
                output.Append(SelectorList(prelude, gate)).Append('{').Append(css, open + 1, close - open - 1);
            }

            if (close < end)
            {
                output.Append('}');
            }

            i = close + 1;
        }
    }

    private static string SelectorList(string prelude, string gate)
    {
        var parts = new List<string>();
        var depth = 0;
        var from = 0;
        for (var i = 0; i < prelude.Length; i++)
        {
            var c = prelude[i];
            if (c == '\\')
            {
                i++;
            }
            else if (c is '"' or '\'')
            {
                i = StringEnd(prelude, i);
            }
            else if (c is '(' or '[')
            {
                depth++;
            }
            else if (c is ')' or ']')
            {
                depth--;
            }
            else if (c == ',' && depth == 0)
            {
                Add(prelude[from..i]);
                from = i + 1;
            }
        }

        Add(prelude[from..]);
        return string.Join(", ", parts) + " ";

        void Add(string selector)
        {
            var trimmed = selector.Trim();
            if (trimmed.Length > 0)
            {
                parts.Add(Gated(trimmed, gate));
            }
        }
    }

    /// <summary>Gates one selector; the result is one selector, or two where the first compound may be <c>&lt;html&gt;</c> and may be one of its descendants.</summary>
    private static string Gated(string selector, string gate)
    {
        var onGate = "." + gate;
        var end = CompoundEnd(selector);
        var first = selector[..end];
        var rest = selector[end..];

        if (StartsWithType(first, "html"))
        {
            return "html" + onGate + first[4..] + rest;
        }

        if (StartsWithType(first, ":root"))
        {
            return ":root" + onGate + first[5..] + rest;
        }

        // No type selector: the compound may describe <html> too (.layout-tv .card, ::selection, *).
        var typeless = first.Length > 0 && first[0] is '.' or '#' or '[' or ':' or '*';
        if (typeless && (first[0] is '*' || first.StartsWith("::", StringComparison.Ordinal) || RootState().IsMatch(first)))
        {
            var merged = onGate + (first[0] == '*' ? first[1..] : first) + rest;
            return merged + ", " + onGate + " " + selector;
        }

        return onGate + " " + selector;
    }

    private static bool StartsWithType(string compound, string name)
        => compound.StartsWith(name, StringComparison.OrdinalIgnoreCase)
            && (compound.Length == name.Length || !IsIdentifierChar(compound[name.Length]));

    private static bool IsIdentifierChar(char c) => char.IsLetterOrDigit(c) || c is '-' or '_' or '\\' || c > 0x7f;

    /// <summary>Gets the end of a selector's first compound: the first space or combinator outside brackets, parentheses and strings.</summary>
    private static int CompoundEnd(string selector)
    {
        var depth = 0;
        for (var i = 0; i < selector.Length; i++)
        {
            var c = selector[i];
            if (c == '\\')
            {
                i++;
            }
            else if (c is '"' or '\'')
            {
                i = StringEnd(selector, i);
            }
            else if (c is '(' or '[')
            {
                depth++;
            }
            else if (c is ')' or ']')
            {
                depth--;
            }
            else if (depth == 0 && (char.IsWhiteSpace(c) || c is '>' or '+' or '~'))
            {
                return i;
            }
        }

        return selector.Length;
    }

    private static string AtName(string prelude)
    {
        var end = 1;
        while (end < prelude.Length && (char.IsLetter(prelude[end]) || prelude[end] == '-'))
        {
            end++;
        }

        return prelude[1..end].ToLowerInvariant();
    }

    /// <summary>Gets the index of the <c>{</c> or <c>;</c> that ends the prelude starting at <paramref name="from"/>, or of a stray <c>}</c>, or <paramref name="end"/>.</summary>
    private static int PreludeEnd(string css, int from, int end)
    {
        var depth = 0;
        for (var i = from; i < end; i++)
        {
            var c = css[i];
            if (c == '\\')
            {
                i++;
            }
            else if (c is '"' or '\'')
            {
                i = StringEnd(css, i);
            }
            else if (IsCommentAt(css, i, end))
            {
                i = CommentEnd(css, i, end) - 1;
            }
            else if (c is '(' or '[')
            {
                depth++;
            }
            else if (c is ')' or ']')
            {
                depth--;
            }
            else if (depth <= 0 && c is '{' or ';' or '}')
            {
                return i;
            }
        }

        return end;
    }

    /// <summary>Gets the index of the <c>}</c> matching the <c>{</c> at <paramref name="open"/>, or <paramref name="end"/> if it never closes.</summary>
    private static int BlockEnd(string css, int open, int end)
    {
        var depth = 1;
        for (var i = open + 1; i < end; i++)
        {
            var c = css[i];
            if (c == '\\')
            {
                i++;
            }
            else if (c is '"' or '\'')
            {
                i = StringEnd(css, i);
            }
            else if (IsCommentAt(css, i, end))
            {
                i = CommentEnd(css, i, end) - 1;
            }
            else if (c == '{')
            {
                depth++;
            }
            else if (c == '}' && --depth == 0)
            {
                return i;
            }
        }

        return end;
    }

    private static bool IsCommentAt(string css, int i, int end) => css[i] == '/' && i + 1 < end && css[i + 1] == '*';

    private static int CommentEnd(string css, int i, int end)
    {
        var close = css.IndexOf("*/", i + 2, end - i - 2, StringComparison.Ordinal);
        return close < 0 ? end : close + 2;
    }

    /// <summary>Gets the index of the quote that closes the string opened at <paramref name="open"/> (or the last character).</summary>
    private static int StringEnd(string text, int open)
    {
        var quote = text[open];
        for (var i = open + 1; i < text.Length; i++)
        {
            if (text[i] == '\\')
            {
                i++;
            }
            else if (text[i] == quote)
            {
                return i;
            }
        }

        return text.Length - 1;
    }

    private static string StripComments(ReadOnlySpan<char> text)
    {
        var result = new StringBuilder(text.Length);
        for (var i = 0; i < text.Length; i++)
        {
            if (text[i] == '/' && i + 1 < text.Length && text[i + 1] == '*')
            {
                var close = text[(i + 2)..].IndexOf("*/", StringComparison.Ordinal);
                if (close < 0)
                {
                    break;
                }

                i += close + 3;
                result.Append(' ');
            }
            else
            {
                result.Append(text[i]);
            }
        }

        return result.ToString();
    }
}
