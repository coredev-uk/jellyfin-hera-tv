using System.Globalization;

namespace Jellyfin.Plugin.HeraTv;

/// <summary>
/// What to do with a saved file that can't be read: keep it. A file Hera writes and then can't read
/// is about to be replaced by the next save, so a copy is taken first. Whoever fixes the cause (a
/// newer Hera TV that reads it, or a person with an editor) still has what was there.
/// </summary>
internal static class DamagedFiles
{
    /// <summary>
    /// Copies <paramref name="file"/> to <c>*.bad</c> beside it, or to <c>*.&lt;time&gt;.bad</c> when a copy is already
    /// there, so no earlier copy is overwritten. Gives the copy's path, or null when it couldn't be made.
    /// </summary>
    public static string? Keep(string file)
    {
        var kept = file + ".bad";
        if (File.Exists(kept))
        {
            kept = string.Create(CultureInfo.InvariantCulture, $"{file}.{DateTime.UtcNow:yyyyMMddHHmmss}.bad");
        }

        try
        {
            File.Copy(file, kept, overwrite: false);
            return kept;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return null;
        }
    }

    /// <summary>Gets a short clause saying where the copy went, for a log message: "it was kept as x.bad", or why it wasn't.</summary>
    public static string Describe(string? kept) => kept is null ? "it could not be copied aside" : $"it was kept as {Path.GetFileName(kept)}";
}
