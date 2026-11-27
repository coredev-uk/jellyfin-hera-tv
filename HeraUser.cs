using Jellyfin.Data;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Database.Implementations.Enums;
using MediaBrowser.Common.Api;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Mvc;

namespace Jellyfin.Plugin.HeraTv;

/// <summary>
/// Who is asking, in one place. Everything Hera TV takes from Jellyfin's authentication lives here,
/// so a change on Jellyfin's side is one edit and the build points at it where it can.
/// </summary>
/// <remarks>
/// Jellyfin's <c>IAuthorizationContext</c> is async-only and its claim names sit in Jellyfin.Api,
/// which plugins don't reference; the claim Jellyfin's own handler sets is mirrored below. The
/// administrator test is the user's permission rather than a role name, which is what
/// <see cref="Policies.RequiresElevation"/> itself checks.
/// </remarks>
internal static class HeraUser
{
    /// <summary>The claim Jellyfin's authentication handler puts the user's id in (Jellyfin.Api, InternalClaimTypes.UserId).</summary>
    private const string UserIdClaim = "Jellyfin-UserId";

    /// <summary>Gets the policy for endpoints only administrators may use.</summary>
    internal const string Elevated = Policies.RequiresElevation;

    /// <summary>Gets the signed-in user's id, or null when the request carries none (an API key, for one).</summary>
    internal static Guid? IdOf(this ControllerBase controller)
        => Guid.TryParse(controller.User.FindFirst(UserIdClaim)?.Value, out var id) ? id : null;

    /// <summary>Gets the signed-in user, or null.</summary>
    internal static User? Current(this ControllerBase controller, IUserManager users)
        => controller.IdOf() is { } id ? users.GetUserById(id) : null;

    /// <summary>Gets whether the signed-in user is an administrator.</summary>
    internal static bool IsAdmin(this ControllerBase controller, IUserManager users)
        => controller.Current(users)?.HasPermission(PermissionKind.IsAdministrator) == true;
}
