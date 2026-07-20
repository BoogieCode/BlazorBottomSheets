using System.Globalization;
using Microsoft.AspNetCore.Components;
using Microsoft.JSInterop;

namespace BlazorBottomSheets;

/// <summary>
/// An iOS / Google Maps-style bottom sheet for Blazor with drag gestures, snap points,
/// a backdrop, and CSS-variable theming. Toggle it with <see cref="IsOpen"/>
/// (supports <c>@bind-IsOpen</c>).
/// </summary>
public partial class BottomSheet : ComponentBase, IAsyncDisposable
{
    private enum SheetState { Closed, Opening, Open, Closing }

    private const string ModulePath = "./_content/BlazorBottomSheets/bottomSheet.js";
    private const double SnapTolerance = 1e-6;

    private ElementReference _containerEl;
    private ElementReference _sheetEl;
    private ElementReference _contentEl;

    private IJSObjectReference? _module;
    private IJSObjectReference? _instance;
    private DotNetObjectReference<BottomSheet>? _selfRef;

    private SheetState _state;
    private bool _busy;
    private bool _disposed;
    private int _generation;
    private string? _appliedOptionsKey;
    private IReadOnlyList<double> _effectiveSnapPoints = [];

    [Inject] private IJSRuntime JS { get; set; } = default!;

    /// <summary>Whether the sheet is open. Supports two-way binding via <c>@bind-IsOpen</c>.</summary>
    [Parameter] public bool IsOpen { get; set; }

    /// <summary>Raised when the sheet requests an <see cref="IsOpen"/> change (e.g. the user dismissed it).</summary>
    [Parameter] public EventCallback<bool> IsOpenChanged { get; set; }

    /// <summary>
    /// Snap points as fractions of the viewport height, e.g. <c>[0.25, 0.5, 0.9]</c>.
    /// When <c>null</c> or empty the sheet sizes itself to its content (auto-height mode)
    /// and dragging can only dismiss it.
    /// </summary>
    [Parameter] public IReadOnlyList<double>? SnapPoints { get; set; }

    /// <summary>The snap point the sheet opens at. Defaults to the smallest value in <see cref="SnapPoints"/>.</summary>
    [Parameter] public double? DefaultSnapPoint { get; set; }

    /// <summary>The main (scrollable) content of the sheet.</summary>
    [Parameter] public RenderFragment? ChildContent { get; set; }

    /// <summary>Optional header rendered above the content. Dragging the header always moves the sheet.</summary>
    [Parameter] public RenderFragment? HeaderContent { get; set; }

    /// <summary>Optional footer pinned below the content.</summary>
    [Parameter] public RenderFragment? FooterContent { get; set; }

    /// <summary>Whether to render the drag handle at the top of the sheet.</summary>
    [Parameter] public bool ShowHandle { get; set; } = true;

    /// <summary>Whether to render a dimming backdrop behind the sheet.</summary>
    [Parameter] public bool ShowBackdrop { get; set; } = true;

    /// <summary>Whether clicking or tapping the backdrop closes the sheet.</summary>
    [Parameter] public bool CloseOnBackdropClick { get; set; } = true;

    /// <summary>Whether pressing Escape closes the sheet.</summary>
    [Parameter] public bool CloseOnEscape { get; set; } = true;

    /// <summary>Whether the sheet can be dragged with a pointer or touch.</summary>
    [Parameter] public bool EnableDrag { get; set; } = true;

    /// <summary>
    /// Whether dragging past the lowest snap point (or downward in auto-height mode) dismisses
    /// the sheet. When <c>false</c>, drags can still move between snap points but the sheet
    /// springs back instead of closing; backdrop and Escape behavior are unaffected.
    /// </summary>
    [Parameter] public bool AllowSwipeDismiss { get; set; } = true;

    /// <summary>
    /// Keeps <see cref="FooterContent"/> pinned to the bottom of the viewport at every snap
    /// point, and pads the content so its scroll end stays reachable above the footer.
    /// When <c>false</c>, the footer sits at the bottom of the (90%-tall) sheet and is only
    /// visible at the top snap, Google Maps-style. Only relevant in snap-point mode.
    /// </summary>
    [Parameter] public bool PinFooter { get; set; } = true;

    /// <summary>Additional CSS class(es) applied to the sheet's fixed container element.</summary>
    [Parameter] public string? Class { get; set; }

    /// <summary>Additional CSS class(es) applied to the sheet element itself.</summary>
    [Parameter] public string? SheetClass { get; set; }

    /// <summary>Additional CSS class(es) applied to the backdrop element.</summary>
    [Parameter] public string? BackdropClass { get; set; }

    /// <summary>Additional CSS class(es) applied to the scrollable content element.</summary>
    [Parameter] public string? ContentClass { get; set; }

    /// <summary>Additional inline CSS applied to the sheet element.</summary>
    [Parameter] public string? Style { get; set; }

    /// <summary>Sheet width cap on large screens (any CSS length). Overrides the <c>--bbs-max-width</c> variable.</summary>
    [Parameter] public string? MaxWidth { get; set; }

    /// <summary>Stacking order of the sheet and backdrop. Overrides the <c>--bbs-z-index</c> variable.</summary>
    [Parameter] public int? ZIndex { get; set; }

    /// <summary>Open/close/snap animation duration. Overrides the <c>--bbs-duration</c> variable.</summary>
    [Parameter] public TimeSpan? AnimationDuration { get; set; }

    /// <summary>Custom content for the drag-handle area, replacing the default pill.</summary>
    [Parameter] public RenderFragment? HandleContent { get; set; }

    /// <summary>Accessible name announced for the dialog.</summary>
    [Parameter] public string? AriaLabel { get; set; }

    /// <summary>Raised after the open animation completes.</summary>
    [Parameter] public EventCallback OnOpened { get; set; }

    /// <summary>Raised after the close animation completes, with the reason the sheet closed.</summary>
    [Parameter] public EventCallback<BottomSheetDismissReason> OnClosed { get; set; }

    /// <summary>Raised when the sheet settles on a different snap point.</summary>
    [Parameter] public EventCallback<double> OnSnapPointChanged { get; set; }

    /// <summary>Attributes to splat onto the container element.</summary>
    [Parameter(CaptureUnmatchedValues = true)]
    public Dictionary<string, object>? AdditionalAttributes { get; set; }

    /// <summary>The snap point the sheet currently rests at, or <c>null</c> when closed or in auto-height mode.</summary>
    public double? CurrentSnapPoint { get; private set; }

    private bool IsSnapMode => _effectiveSnapPoints.Count > 0;

    private string? ContainerStyleValue
    {
        get
        {
            var parts = new List<string>(3);
            if (ZIndex is int z)
            {
                parts.Add(string.Create(CultureInfo.InvariantCulture, $"--bbs-z-index:{z}"));
            }

            if (MaxWidth is { Length: > 0 } w)
            {
                parts.Add($"--bbs-max-width:{w}");
            }

            if (AnimationDuration is TimeSpan d)
            {
                parts.Add(string.Create(CultureInfo.InvariantCulture, $"--bbs-duration:{d.TotalMilliseconds:0}ms"));
            }

            return parts.Count > 0 ? string.Join(';', parts) : null;
        }
    }

    private string? SheetStyleValue
    {
        get
        {
            var height = IsSnapMode
                ? string.Create(CultureInfo.InvariantCulture, $"height:{_effectiveSnapPoints[^1] * 100:0.####}%;")
                : null;
            return height is null && Style is null ? null : $"{height}{Style}";
        }
    }

    /// <summary>
    /// Animates the open sheet to the given snap point. The value must be one of
    /// <see cref="SnapPoints"/>. Does nothing when the sheet is closed or in auto-height mode.
    /// </summary>
    public async Task SnapToAsync(double snapPoint)
    {
        if (_state != SheetState.Open || _instance is null || !IsSnapMode)
        {
            return;
        }

        var match = _effectiveSnapPoints.FirstOrDefault(s => Math.Abs(s - snapPoint) < SnapTolerance, double.NaN);
        if (double.IsNaN(match))
        {
            throw new ArgumentException($"'{snapPoint}' is not one of the configured SnapPoints.", nameof(snapPoint));
        }

        var instance = _instance;
        await SafeJsAsync(() => instance.InvokeVoidAsync("snapTo", match).AsTask());
    }

    /// <inheritdoc />
    protected override void OnParametersSet()
    {
        _effectiveSnapPoints = NormalizeSnapPoints(SnapPoints);

        // Materialize the DOM (hidden) in the same render that delivered IsOpen=true.
        // When busy, the reconciliation loop in OnAfterRenderAsync picks the change up itself.
        if (IsOpen && _state == SheetState.Closed && !_busy)
        {
            _state = SheetState.Opening;
        }
    }

    /// <inheritdoc />
    protected override async Task OnAfterRenderAsync(bool firstRender)
    {
        if (_busy || _disposed)
        {
            return;
        }

        _busy = true;
        try
        {
            // Single-flight reconciliation loop: converge _state toward the live IsOpen value,
            // re-reading it each iteration so rapid toggles are handled in order.
            while (!_disposed)
            {
                if (_state == SheetState.Opening)
                {
                    if (!IsOpen)
                    {
                        _state = SheetState.Closed;
                        StateHasChanged();
                        continue;
                    }

                    _module ??= await JS.InvokeAsync<IJSObjectReference>("import", ModulePath);
                    _selfRef ??= DotNetObjectReference.Create(this);
                    _generation++;
                    var options = BuildOptions();
                    _appliedOptionsKey = OptionsKey();
                    _instance = await _module.InvokeAsync<IJSObjectReference>(
                        "createSheet", _containerEl, _sheetEl, _contentEl, _selfRef, options);
                    await _instance.InvokeVoidAsync("open");
                    _state = SheetState.Open;
                    CurrentSnapPoint = options.InitialSnapPoint;
                    StateHasChanged();
                    await OnOpened.InvokeAsync();
                }
                else if (_state == SheetState.Open && !IsOpen)
                {
                    _state = SheetState.Closing;
                    var instance = _instance;
                    if (instance is not null)
                    {
                        await SafeJsAsync(() => instance.InvokeVoidAsync("close").AsTask());
                    }

                    await DisposeInstanceAsync();
                    _state = SheetState.Closed;
                    CurrentSnapPoint = null;
                    StateHasChanged();
                    await OnClosed.InvokeAsync(BottomSheetDismissReason.Programmatic);
                }
                else if (_state == SheetState.Closed && IsOpen)
                {
                    // Reopen queued while we were closing: render the DOM first, then
                    // continue from the OnAfterRenderAsync of that render (fresh element refs).
                    _state = SheetState.Opening;
                    StateHasChanged();
                    break;
                }
                else
                {
                    if (_state == SheetState.Open && _instance is not null)
                    {
                        var key = OptionsKey();
                        if (key != _appliedOptionsKey)
                        {
                            _appliedOptionsKey = key;
                            var instance = _instance;
                            await SafeJsAsync(() => instance.InvokeVoidAsync("updateOptions", BuildOptions()).AsTask());
                        }
                    }

                    break;
                }
            }
        }
        catch (JSDisconnectedException) { }
        catch (TaskCanceledException) { }
        catch (ObjectDisposedException) { }
        finally
        {
            _busy = false;
        }
    }

    /// <summary>Invoked from JavaScript after the user dismissed the sheet (drag, backdrop, or Escape). Not intended for application use.</summary>
    [JSInvokable]
    public async Task OnUserDismissedJs(int generation, string reason)
    {
        if (_disposed || _busy || generation != _generation || _instance is null)
        {
            return;
        }

        _busy = true;
        try
        {
            // JS has already animated the sheet out; just tear down and report.
            await DisposeInstanceAsync();
            _state = SheetState.Closed;
            CurrentSnapPoint = null;
            IsOpen = false;
            StateHasChanged();
            await IsOpenChanged.InvokeAsync(false);
            await OnClosed.InvokeAsync(ToReason(reason));
        }
        finally
        {
            _busy = false;
        }
    }

    /// <summary>Invoked from JavaScript when the sheet settles on a different snap point. Not intended for application use.</summary>
    [JSInvokable]
    public async Task OnSnapChangedJs(int generation, double snapPoint)
    {
        if (_disposed || generation != _generation)
        {
            return;
        }

        CurrentSnapPoint = snapPoint;
        StateHasChanged();
        await OnSnapPointChanged.InvokeAsync(snapPoint);
    }

    /// <inheritdoc />
    public async ValueTask DisposeAsync()
    {
        if (_disposed)
        {
            return;
        }

        _disposed = true;
        await DisposeInstanceAsync();
        if (_module is not null)
        {
            var module = _module;
            _module = null;
            await SafeJsAsync(() => module.DisposeAsync().AsTask());
        }

        _selfRef?.Dispose();
        _selfRef = null;
        GC.SuppressFinalize(this);
    }

    private async Task DisposeInstanceAsync()
    {
        _generation++; // invalidates callbacks from the instance being torn down
        var instance = _instance;
        _instance = null;
        if (instance is null)
        {
            return;
        }

        await SafeJsAsync(() => instance.InvokeVoidAsync("dispose").AsTask());
        await SafeJsAsync(() => instance.DisposeAsync().AsTask());
    }

    private BottomSheetJsOptions BuildOptions() => new()
    {
        SnapPoints = IsSnapMode ? _effectiveSnapPoints.ToArray() : null,
        InitialSnapPoint = ResolveInitialSnap(),
        EnableDrag = EnableDrag,
        AllowSwipeDismiss = AllowSwipeDismiss,
        PinFooter = PinFooter,
        CloseOnBackdropClick = CloseOnBackdropClick,
        CloseOnEscape = CloseOnEscape,
        Generation = _generation,
    };

    private double? ResolveInitialSnap()
    {
        if (!IsSnapMode)
        {
            return null;
        }

        if (DefaultSnapPoint is double d)
        {
            var match = _effectiveSnapPoints.FirstOrDefault(s => Math.Abs(s - d) < SnapTolerance, double.NaN);
            if (!double.IsNaN(match))
            {
                return match;
            }
        }

        return _effectiveSnapPoints[0];
    }

    private string OptionsKey() => string.Join(';', _effectiveSnapPoints) +
        $"|{DefaultSnapPoint}|{EnableDrag}|{AllowSwipeDismiss}|{PinFooter}|{CloseOnBackdropClick}|{CloseOnEscape}";

    private static IReadOnlyList<double> NormalizeSnapPoints(IReadOnlyList<double>? points)
    {
        if (points is null || points.Count == 0)
        {
            return [];
        }

        return points.Where(p => p > 0.02 && p <= 1.0).Distinct().Order().ToArray();
    }

    private static BottomSheetDismissReason ToReason(string reason) => reason switch
    {
        "drag" => BottomSheetDismissReason.Drag,
        "backdrop" => BottomSheetDismissReason.Backdrop,
        "escape" => BottomSheetDismissReason.Escape,
        _ => BottomSheetDismissReason.Programmatic,
    };

    private static async Task SafeJsAsync(Func<Task> action)
    {
        try
        {
            await action();
        }
        catch (JSDisconnectedException) { }
        catch (TaskCanceledException) { }
        catch (ObjectDisposedException) { }
    }

    internal sealed class BottomSheetJsOptions
    {
        public double[]? SnapPoints { get; set; }
        public double? InitialSnapPoint { get; set; }
        public bool EnableDrag { get; set; }
        public bool AllowSwipeDismiss { get; set; }
        public bool PinFooter { get; set; }
        public bool CloseOnBackdropClick { get; set; }
        public bool CloseOnEscape { get; set; }
        public int Generation { get; set; }
    }
}
