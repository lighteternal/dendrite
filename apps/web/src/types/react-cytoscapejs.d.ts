declare module "react-cytoscapejs" {
  import * as React from "react";
  import type cytoscape from "cytoscape";

  export type CytoscapeComponentProps = {
    elements?: unknown[];
    stylesheet?: unknown;
    style?: React.CSSProperties;
    layout?: Record<string, unknown>;
    cy?: (cy: cytoscape.Core) => void;
    className?: string;
    [key: string]: unknown;
  };

  const CytoscapeComponent: React.ComponentType<CytoscapeComponentProps>;
  export default CytoscapeComponent;
}
