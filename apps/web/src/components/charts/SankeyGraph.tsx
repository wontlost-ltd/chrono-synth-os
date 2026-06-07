import React, { useRef, useEffect, useMemo, useState } from 'react';
import { sankey, sankeyLinkHorizontal, type SankeyNode, type SankeyLink } from 'd3-sankey';
import { useTranslation } from 'react-i18next';

interface Node {
  id: string;
  label: string;
}

interface Edge {
  source: string;
  target: string;
  value: number;
  probability?: number;
}

interface SankeyGraphProps {
  nodes: Node[];
  edges: Edge[];
  height?: number;
  onSelectNode?: (nodeId: string) => void;
}

const NODE_COLORS = [
  'var(--color-chart-1)',
  'var(--color-chart-2)',
  'var(--color-chart-3)',
  'var(--color-chart-4)',
  'var(--color-chart-5)',
];

const FONT_SIZE_LABEL = 'var(--font-size-chart-label, 12px)';
const FONT_SIZE_ANNOTATION = 'var(--font-size-chart-annotation, 11px)';

interface SNode {
  id: string;
  label: string;
}

interface SLink {
  source: number;
  target: number;
  value: number;
  probability?: number;
}

export const SankeyGraph = React.memo(function SankeyGraph({ nodes, edges, height = 300, onSelectNode }: SankeyGraphProps) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [width, setWidth] = useState(600);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    setWidth(container.clientWidth);
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(entries => {
      const entry = entries[0];
      if (entry) setWidth(entry.contentRect.width);
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  const layout = useMemo(() => {
    const nodeMap = new Map(nodes.map((n, i) => [n.id, i]));
    const sNodes: SNode[] = nodes.map(n => ({ id: n.id, label: n.label }));
    const sLinks: SLink[] = edges
      .filter(e => nodeMap.has(e.source) && nodeMap.has(e.target))
      .map(e => ({
        source: nodeMap.get(e.source)!,
        target: nodeMap.get(e.target)!,
        value: Math.max(e.value, 0.01),
        probability: e.probability,
      }));

    const generator = sankey<SNode, SLink>()
      .nodeWidth(20)
      .nodePadding(16)
      .extent([[16, 16], [width - 16, height - 16]]);

    return generator({
      nodes: sNodes.map(n => ({ ...n })),
      links: sLinks.map(l => ({ ...l })),
    });
  }, [nodes, edges, width, height]);

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    svg.innerHTML = '';

    const ns = 'http://www.w3.org/2000/svg';

    const linkGen = sankeyLinkHorizontal();
    for (const link of layout.links) {
      const path = document.createElementNS(ns, 'path');
      const d = linkGen(link as SankeyLink<SNode, SLink>);
      if (d) path.setAttribute('d', d);
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke', 'var(--color-border)');
      path.setAttribute('stroke-opacity', '0.4');
      path.setAttribute('stroke-width', String(Math.max((link as SankeyLink<SNode, SLink>).width ?? 2, 2)));
      svg.appendChild(path);

      if ((link as SLink).probability != null) {
        const sl = link as SankeyLink<SNode, SLink>;
        const text = document.createElementNS(ns, 'text');
        const midX = ((sl.source as SankeyNode<SNode, SLink>).x1! + (sl.target as SankeyNode<SNode, SLink>).x0!) / 2;
        const midY = (sl.y0! + sl.y1!) / 2;
        text.setAttribute('x', String(midX));
        text.setAttribute('y', String(midY));
        text.setAttribute('text-anchor', 'middle');
        text.setAttribute('fill', 'var(--color-text-secondary)');
        text.setAttribute('font-size', FONT_SIZE_ANNOTATION);
        text.textContent = `${((link as SLink).probability! * 100).toFixed(0)}%`;
        svg.appendChild(text);
      }
    }

    for (const [i, node] of layout.nodes.entries()) {
      const sn = node as SankeyNode<SNode, SLink>;
      const g = document.createElementNS(ns, 'g');

      if (onSelectNode) {
        g.setAttribute('role', 'button');
        g.setAttribute('tabindex', '0');
        g.setAttribute('aria-label', sn.label);
        g.style.cursor = 'pointer';
        g.style.outline = 'none';
        g.addEventListener('focus', () => { g.style.outline = '2px solid var(--color-primary)'; g.style.outlineOffset = '2px'; });
        g.addEventListener('blur', () => { g.style.outline = 'none'; });
        g.addEventListener('click', () => onSelectNode(sn.id));
        g.addEventListener('keydown', (e: KeyboardEvent) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelectNode(sn.id); }
        });
      }

      const rect = document.createElementNS(ns, 'rect');
      rect.setAttribute('x', String(sn.x0));
      rect.setAttribute('y', String(sn.y0));
      rect.setAttribute('width', String(sn.x1! - sn.x0!));
      rect.setAttribute('height', String(Math.max(sn.y1! - sn.y0!, 4)));
      rect.setAttribute('fill', NODE_COLORS[i % NODE_COLORS.length]!);
      rect.setAttribute('rx', '4');
      g.appendChild(rect);

      const text = document.createElementNS(ns, 'text');
      text.setAttribute('x', String(sn.x0! + (sn.x1! - sn.x0!) / 2));
      text.setAttribute('y', String(sn.y0! - 6));
      text.setAttribute('text-anchor', 'middle');
      text.setAttribute('fill', 'var(--color-text-primary)');
      text.setAttribute('font-size', FONT_SIZE_LABEL);
      text.setAttribute('font-weight', '500');
      text.textContent = sn.label;
      g.appendChild(text);

      svg.appendChild(g);
    }
  }, [layout, onSelectNode]);

  return (
    <figure ref={containerRef} className="w-full overflow-hidden">
      <svg ref={svgRef} width={width} height={height} aria-label={t('aria.sankeyChart')} />
      <table className="sr-only">
        <caption>{t('aria.sankeyData')}</caption>
        <thead><tr><th>{t('aria.sourceColumn')}</th><th>{t('aria.targetColumn')}</th><th>{t('aria.weightColumn')}</th><th>{t('aria.probabilityColumn')}</th></tr></thead>
        <tbody>
          {(() => {
            const nodeLabels = new Map(nodes.map(n => [n.id, n.label]));
            return edges.map((e, i) => (
              <tr key={i}>
                <td>{nodeLabels.get(e.source) ?? e.source}</td>
                <td>{nodeLabels.get(e.target) ?? e.target}</td>
                <td>{e.value}</td>
                <td>{e.probability != null ? `${(e.probability * 100).toFixed(0)}%` : '-'}</td>
              </tr>
            ));
          })()}
        </tbody>
      </table>
    </figure>
  );
});
