using System.Globalization;
using System.Text.Json.Nodes;

namespace Jellyfin.Plugin.HeraTv;

/// <summary>
/// Reads what other servers send without trusting its shape. <see cref="JsonNode"/>'s own casts and
/// <c>GetValue</c> throw when a field changes type (a number that becomes a string, an object that
/// becomes a list); these give null, or nothing, instead, so one odd field costs that field and not
/// the page. A number sent as text, which servers do change between versions, still reads as a number.
/// </summary>
internal static class JsonRead
{
    /// <summary>Gets a member of an object, or null when the node isn't an object or has no such member.</summary>
    public static JsonNode? At(this JsonNode? node, string name) => node is JsonObject obj ? obj[name] : null;

    /// <summary>Gets a member of a member, for the two-step reads that most records need.</summary>
    public static JsonNode? At(this JsonNode? node, string name, string inner) => node.At(name).At(inner);

    /// <summary>Gets the non-null elements of an array; nothing when the node isn't one.</summary>
    public static IEnumerable<JsonNode> Items(this JsonNode? node)
        => node is JsonArray array ? array.OfType<JsonNode>() : [];

    /// <summary>Gets the text of a string value, or null for anything else.</summary>
    public static string? Str(this JsonNode? node)
        => node is JsonValue value && value.TryGetValue(out string? text) ? text : null;

    /// <summary>
    /// Gets a number, whether it was parsed from JSON, built in memory from an int, long, float, double or decimal
    /// (<c>TryGetValue</c> only matches the exact type a node holds, so each is tried), or sent as text; null for anything else.
    /// </summary>
    public static double? Num(this JsonNode? node)
    {
        if (node is not JsonValue value)
        {
            return null;
        }

        if (value.TryGetValue(out double number))
        {
            return number;
        }

        if (value.TryGetValue(out long whole))
        {
            return whole;
        }

        if (value.TryGetValue(out int small))
        {
            return small;
        }

        if (value.TryGetValue(out decimal exact))
        {
            return (double)exact;
        }

        if (value.TryGetValue(out float single))
        {
            return single;
        }

        return value.TryGetValue(out string? text) && double.TryParse(text, NumberStyles.Float, CultureInfo.InvariantCulture, out var parsed) ? parsed : null;
    }

    /// <summary>Gets a whole number; null for anything else, or a number that isn't whole or doesn't fit.</summary>
    public static int? Int(this JsonNode? node)
        => node.Num() is { } number && number == Math.Floor(number) && number is >= int.MinValue and <= int.MaxValue ? (int)number : null;

    /// <summary>Gets a whole number that may not fit an int.</summary>
    public static long? Long(this JsonNode? node)
    {
        if (node is JsonValue value && value.TryGetValue(out long exact))
        {
            return exact;
        }

        return node.Num() is { } number && number == Math.Floor(number) && Math.Abs(number) < 9e15 ? (long)number : null;
    }

    /// <summary>Gets a true or false; null for anything else.</summary>
    public static bool? Bool(this JsonNode? node)
        => node is JsonValue value && value.TryGetValue(out bool flag) ? flag : null;
}
