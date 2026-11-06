import { studioTheme } from "ag-studio";

// The AgentShelf look for AG Studio. Every value points at a token in dashboard.css, so widgets,
// the grid and charts follow the same zinc ramp and carbon-blue accent as the other seller pages,
// and dark mode comes along without a second theme.

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
  fontFamily: "var(--font-geist-sans), Arial, Helvetica, sans-serif",
  fontSize: 14,
  textColor: token("text"),
  foregroundColor: token("text"),
  subtleTextColor: token("muted"),
  backgroundColor: token("surface"),
  borderColor: token("line"),
  accentColor: token("ink"),
  iconColor: token("muted"),
  rowHoverColor: token("hover"),

  // The canvas is the page itself, with no frame around it.
  studioWrapperBorder: false,
  studioWrapperBorderRadius: 0,
  studioWrapperSpacing: 0,
  studioWrapperBackgroundColor: token("canvas"),
  studioCanvasBorder: false,
  studioCanvasBorderRadius: 0,
  studioCanvasShadow: false,
  studioCanvasBackgroundColor: token("canvas"),
  studioCanvasPadding: 8,
  studioCanvasRowHeight: 16,
  studioCanvasFontFamily: "var(--font-geist-sans), Arial, Helvetica, sans-serif",

  // Widgets read like sheets from a receipt book: flat, one hairline, small radius.
  studioWidgetBackgroundColor: token("surface"),
  studioWidgetBorder: line("line"),
  studioWidgetBorderRadius: 6,
  studioWidgetPadding: 12,
  studioWidgetTitleFontSize: 15,
  studioWidgetTitleFontWeight: 600,
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
  studioPanelHeaderFontWeight: 600,
  studioPanelChevronButtonHoverBackgroundColor: token("hover"),
  studioPanelChevronButtonHoverColor: token("ink"),
  studioToggleButtonActiveBackgroundColor: token("hover"),
  studioToggleButtonActiveBorderColor: token("ink"),
  studioToggleButtonActiveColor: token("ink"),

  ...palette,
});
