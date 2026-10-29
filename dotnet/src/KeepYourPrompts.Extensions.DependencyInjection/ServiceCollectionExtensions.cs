using System;
using KeepYourPrompts;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Logging;

namespace Microsoft.Extensions.DependencyInjection
{
    /// <summary>Registers <see cref="KeepYourPromptsClient"/> as a singleton.</summary>
    public static class KeepYourPromptsServiceCollectionExtensions
    {
        /// <summary>
        /// Registers a singleton <see cref="KeepYourPromptsClient"/> configured from <c>KYP_*</c> environment
        /// variables, then <paramref name="configure"/>. The client is created on first resolution (it loads the
        /// snapshot or disk cache at once, or waits up to <see cref="KeepYourPromptsOptions.StartupTimeout"/> on
        /// the network) and disposed with the container. Logs go to <see cref="ILogger"/> category
        /// <c>KeepYourPrompts</c> when an <see cref="ILoggerFactory"/> is registered and no
        /// <see cref="KeepYourPromptsOptions.Logger"/> was set.
        /// </summary>
        public static IServiceCollection AddKeepYourPrompts(this IServiceCollection services, Action<KeepYourPromptsOptions>? configure = null)
        {
            if (services == null) throw new ArgumentNullException(nameof(services));
            services.TryAddSingleton(sp =>
            {
                var options = KeepYourPromptsOptions.FromEnvironment();
                configure?.Invoke(options);
                if (options.Logger == null && sp.GetService(typeof(ILoggerFactory)) is ILoggerFactory factory)
                {
                    var logger = factory.CreateLogger("KeepYourPrompts");
                    options.Logger = (level, message) => logger.Log(Map(level), "{Message}", message);
                }
                return KeepYourPromptsClient.Create(options);
            });
            return services;
        }

        private static LogLevel Map(KypLogLevel level)
        {
            switch (level)
            {
                case KypLogLevel.Debug: return LogLevel.Debug;
                case KypLogLevel.Info: return LogLevel.Information;
                case KypLogLevel.Warn: return LogLevel.Warning;
                case KypLogLevel.Error: return LogLevel.Error;
                default: return LogLevel.None;
            }
        }
    }
}
