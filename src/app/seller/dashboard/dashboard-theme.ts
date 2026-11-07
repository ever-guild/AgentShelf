import { studioTheme } from "ag-studio";

// The AgentShelf look for AG Studio. Every value points at a token in dashboard.css, so widgets,
// the grid and charts follow the same zinc ramp and carbon-blue accent as the other seller pages,
// and dark mode comes along without a second theme.

const FONT = "var(--font-geist-sans), Arial, Helvetica, sans-serif";

const token = (name: string) => `var(--studio-${name})`;
const line = (color: string) => ({ width: 1, color: token(color) });

const CHART_SERIES = ["series-1", "series-2", "series-3", "series-4", "series-5", "series-6"];

const palette = Object.fromEntries(
  CHART_SERIES.flatMap((name, index) => [
    [`chartPaletteFills${index + 1}Color`, token(name)],
    [`chartPaletteStrokes${index + 1}Color`, token(name)],
  ]),
);

export const agentShelfTheme = studioTheme.withParams({
  fontFamily: FONT,
  fontSize: 14,
  textColor: token("text"),
  foregroundColor: token("text"),
  subtleTextColor: token("muted"),
  backgroundColor: token("surface"),
  borderColor: token("line"),
  accentColor: token("ink"),
  iconColor: token("muted"),
  rowHoverColor: token("hover"),

  // The orders grid: rows a finger or a pointer can land on, with hairlines from the same ramp.
  gridRowHeight: 36,
  gridHeaderHeight: 36,
  gridHeaderFontWeight: 500,
  gridHeaderTextColor: token("muted"),
  gridHeaderBackgroundColor: token("surface"),
  gridRowBorder: line("line"),
  gridHeaderRowBorder: line("line"),

  // The canvas is the page itself, with no frame around it.
  studioWrapperBorder: false,
  studioWrapperBorderRadius: 0,
  studioWrapperSpacing: 0,
  studioWrapperBackgroundColor: token("canvas"),
  studioCanvasBorder: false,
  studioCanvasBorderRadius: 0,
  studioCanvasShadow: false,
  studioCanvasBackgroundColor: token("canvas"),
  // With a widget's own padding this puts its edge on the page's gutter, under the page title.
  studioCanvasPadding: "var(--studio-canvas-padding)",
  studioCanvasRowHeight: 16,
  studioCanvasFontFamily: FONT,

  // Widgets read like sheets from a receipt book: flat, one hairline, small radius.
  studioWidgetBackgroundColor: token("surface"),
  studioWidgetBorder: line("line"),
  studioWidgetBorderRadius: 6,
  studioWidgetPadding: 8,
  studioWidgetTitleFontSize: 15,
  studioWidgetTitleFontWeight: 500,
  studioWidgetTitleTextColor: token("text"),
  studioWidgetSubtitleFontSize: 13,
  studioWidgetSubtitleTextColor: token("muted"),
  studioWidgetCaptionFontSize: 12,
  studioWidgetCaptionTextColor: token("muted"),
  studioWidgetResizeBorderColor: token("ink"),

  studioPanelContainerBackgroundColor: token("surface"),
  studioPanelContainerBorder: line("line"),
  studioPanelContainerBorderRadius: 0,
  studioPanelDividerColor: token("line"),
  studioPanelDividerActiveColor: token("ink"),
  studioPanelSectionBorderColor: token("line"),
  studioPanelHeaderFontWeight: 500,
  studioPanelChevronButtonHoverBackgroundColor: token("hover"),
  studioPanelChevronButtonHoverColor: token("ink"),
  studioToggleButtonActiveBackgroundColor: token("hover"),
  studioToggleButtonActiveBorderColor: token("ink"),
  studioToggleButtonActiveColor: token("ink"),

  // Charts sit on a muted grid, in the page's type, and get their one accent from the palette.
  chartFontFamily: FONT,
  chartAxisLabelFontFamily: FONT,
  chartAxisTitleFontFamily: FONT,
  chartSeriesLabelFontFamily: FONT,
  chartTextColor: token("text"),
  chartSubtleTextColor: token("muted"),
  chartAxisLabelColor: token("muted"),
  chartAxisTitleColor: token("muted"),
  chartAxisLineColor: token("line"),
  chartGridLineColor: token("line"),

  ...palette,
});
