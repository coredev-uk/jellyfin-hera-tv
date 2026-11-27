using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.HeraTv;

/// <summary>
/// A background feature that can fail without taking Jellyfin with it. .NET stops the whole host
/// when a hosted service throws, and a member that a newer Jellyfin has changed throws where the
/// calling method is compiled, which no try inside that method can catch. So the work lives in
/// <see cref="RunAsync"/>, one call away from the catch-all here: whatever it throws, the feature
/// stops, the failure is logged as an error and reported to <see cref="ServerHealth"/>, and the
/// server carries on.
/// </summary>
public abstract class GuardedBackgroundService(string feature, ServerHealth health) : BackgroundService
{
    /// <summary>Gets where the feature reports faults, for the work inside <see cref="RunAsync"/>.</summary>
    protected ServerHealth Health => health;

    protected sealed override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        try
        {
            // Hands startup back before any work: the host waits for the first await.
            await Task.Yield();
            await RunAsync(stoppingToken).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
        {
            // The server is stopping.
        }
        catch (Exception ex)
        {
            health.Stopped(feature, ex);
        }
    }

    /// <summary>Does the feature's work until the server stops. Subscribe to Jellyfin's events and read the stores here, not in the constructor.</summary>
    protected abstract Task RunAsync(CancellationToken stoppingToken);
}

/// <summary>Stands in for a background feature that was switched off or couldn't be built, so that costs one feature rather than startup.</summary>
internal sealed class IdleBackgroundService : BackgroundService
{
    protected override Task ExecuteAsync(CancellationToken stoppingToken) => Task.CompletedTask;
}

internal static class GuardedServices
{
    /// <summary>The operator's switch for every Hera background feature, for ruling them out while upgrading Jellyfin.</summary>
    private const string SwitchVariable = "HERATV_BACKGROUND";

    /// <summary>
    /// Registers a background feature so that a failure to build it (its constructor takes Jellyfin
    /// services, and one of them may have changed) loses that feature and nothing else.
    /// </summary>
    internal static IServiceCollection AddGuardedHostedService<T>(this IServiceCollection services, string feature, Func<IServiceProvider, T>? create = null)
        where T : GuardedBackgroundService
        => services.AddSingleton<IHostedService>(provider =>
        {
            var health = provider.GetRequiredService<ServerHealth>();
            var logger = provider.GetRequiredService<ILoggerFactory>().CreateLogger(typeof(GuardedServices).FullName!);
            if (string.Equals(Environment.GetEnvironmentVariable(SwitchVariable), "off", StringComparison.OrdinalIgnoreCase))
            {
                logger.LogInformation("Hera TV's {Feature} is off because {Variable} is set to off", feature, SwitchVariable);
                return new IdleBackgroundService();
            }

            try
            {
                return create?.Invoke(provider) ?? ActivatorUtilities.CreateInstance<T>(provider);
            }
            catch (Exception ex)
            {
                health.Stopped(feature, ex);
                return new IdleBackgroundService();
            }
        });
}
