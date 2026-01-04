/**
 * Mock for react-cytoscapejs component
 * Integrates with the Cytoscape.js mock to provide realistic testing
 */

import React, { useEffect, useRef } from 'react';
import { createMockCytoscape } from './cytoscape';
import type cytoscape from 'cytoscape';

interface CytoscapeComponentProps {
  elements?: cytoscape.ElementDefinition[];
  stylesheet?: cytoscape.StylesheetCSS[];
  layout?: cytoscape.LayoutOptions;
  style?: React.CSSProperties;
  cy?: (cy: cytoscape.Core) => void;
  className?: string;
  [key: string]: unknown;
}

const CytoscapeComponent: React.FC<CytoscapeComponentProps> = (props) => {
  const {
    cy: cyCallback,
    elements,
    style,
    className,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    stylesheet,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    layout,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars, react/prop-types
    userZoomingEnabled,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars, react/prop-types
    userPanningEnabled,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars, react/prop-types
    boxSelectionEnabled,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars, react/prop-types
    autoungrabify,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars, react/prop-types
    autounselectify,
    ...rest
  } = props;
  const cyInstanceRef = useRef<ReturnType<typeof createMockCytoscape> | null>(null);

  useEffect(() => {
    // Create mock Cytoscape instance
    if (!cyInstanceRef.current) {
      cyInstanceRef.current = createMockCytoscape();

      // Add initial elements if provided
      if (elements && elements.length > 0) {
        cyInstanceRef.current.add(elements);
      }

      // Call the cy callback if provided
      if (cyCallback) {
        cyCallback(cyInstanceRef.current as unknown as cytoscape.Core);
      }
    }

    return () => {
      cyInstanceRef.current?.destroy();
      cyInstanceRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cyCallback]);

  // Update elements when they change
  useEffect(() => {
    if (cyInstanceRef.current && elements) {
      // Simple approach: remove all and re-add (tests typically don't rely on incremental updates)
      cyInstanceRef.current.elements().forEach((el) => el.remove());
      cyInstanceRef.current.add(elements);
    }
  }, [elements]);

  return <div data-testid="cytoscape-mock" className={className} style={style} {...rest} />;
};

export default CytoscapeComponent;
