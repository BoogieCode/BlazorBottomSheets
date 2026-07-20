namespace BlazorBottomSheets;

/// <summary>
/// Describes what caused a <see cref="BottomSheet"/> to close.
/// </summary>
public enum BottomSheetDismissReason
{
    /// <summary>The sheet was closed from code (the <c>IsOpen</c> parameter was set to <c>false</c>).</summary>
    Programmatic,

    /// <summary>The user dragged or flicked the sheet down past the dismiss threshold.</summary>
    Drag,

    /// <summary>The user clicked or tapped the backdrop.</summary>
    Backdrop,

    /// <summary>The user pressed the Escape key.</summary>
    Escape,
}
