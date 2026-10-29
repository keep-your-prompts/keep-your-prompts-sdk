using global::OpenTelemetry.Metrics;
using global::OpenTelemetry.Trace;

namespace KeepYourPrompts.OpenTelemetry
{
    /// <summary>Provider builder and client extensions.</summary>
    public static class KeepYourPromptsOpenTelemetryExtensions
    {
        /// <summary>Listens to the <c>keepyourprompts</c> ActivitySource (<c>kyp.refresh</c> activities).</summary>
        public static TracerProviderBuilder AddKeepYourPromptsInstrumentation(this TracerProviderBuilder builder) =>
            builder.AddSource(KeepYourPromptsInstrumentation.ScopeName);

        /// <summary>Listens to the <c>keepyourprompts</c> Meter (<c>kyp.*</c> metrics).</summary>
        public static MeterProviderBuilder AddKeepYourPromptsInstrumentation(this MeterProviderBuilder builder) =>
            builder.AddMeter(KeepYourPromptsInstrumentation.ScopeName);

        /// <summary>Records <c>kyp.refresh</c> activities and <c>kyp.*</c> metrics for this client; see <see cref="KeepYourPromptsInstrumentation.Instrument"/>.</summary>
        public static KeepYourPromptsInstrumentation AddOpenTelemetry(this KeepYourPromptsClient client, KeepYourPromptsInstrumentationOptions? options = null) =>
            KeepYourPromptsInstrumentation.Instrument(client, options);
    }
}
