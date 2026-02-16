"use client";

import { useEffect, useRef } from "react";

type HopPath = {
  ids: number[];
  speed: number;
  phase: number;
  hue: number;
};

type MacroNode = {
  baseX: number;
  baseY: number;
  phase: number;
  radius: number;
  hue: number;
};

type MicroNode = {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  baseRadius: number;
  phase: number;
  hue: number;
};

type MiniGraph = {
  cx: number;
  cy: number;
  vx: number;
  vy: number;
  phase: number;
  twist: number;
  scale: number;
  depth: number;
  radiusLimit: number;
  pulsePhase: number;
  nodes: MicroNode[];
  links: Array<[number, number]>;
  triangles: Array<[number, number, number]>;
  paths: HopPath[];
};

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}

function edgeKey(a: number, b: number): string {
  return a < b ? `${a}-${b}` : `${b}-${a}`;
}

export function LandingMoleculeBackground() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;

    let frame = 0;
    let raf = 0;
    let width = 0;
    let height = 0;

    const macroNodes: MacroNode[] = [];
    const macroLinks: Array<[number, number]> = [];
    const macroPaths: HopPath[] = [];
    const miniGraphs: MiniGraph[] = [];

    const resize = () => {
      width = window.innerWidth;
      height = window.innerHeight;
      const dpr = Math.max(1, window.devicePixelRatio || 1);
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    const buildMacroNetwork = () => {
      macroNodes.length = 0;
      macroLinks.length = 0;
      macroPaths.length = 0;

      const columns = clampInt(width / 220, 5, 11);
      const rows = clampInt(height / 170, 3, 7);
      const leftPad = width * 0.07;
      const rightPad = width * 0.07;
      const topPad = height * 0.11;
      const bottomPad = height * 0.11;
      const xStep = (width - leftPad - rightPad) / Math.max(1, columns - 1);
      const yStep = (height - topPad - bottomPad) / Math.max(1, rows - 1);

      const grid: number[][] = Array.from({ length: rows }, () => Array(columns).fill(-1));
      const hueBand = [204, 211, 199, 24];

      for (let row = 0; row < rows; row += 1) {
        for (let col = 0; col < columns; col += 1) {
          const node: MacroNode = {
            baseX: leftPad + col * xStep + (Math.random() - 0.5) * 28,
            baseY: topPad + row * yStep + (Math.random() - 0.5) * 24,
            phase: Math.random() * Math.PI * 2,
            radius: 0.9 + Math.random() * 1.5,
            hue: hueBand[(row + col) % hueBand.length] as number,
          };
          grid[row]![col] = macroNodes.push(node) - 1;
        }
      }

      const links = new Set<string>();
      const connect = (a: number, b: number) => {
        const key = edgeKey(a, b);
        if (links.has(key)) return;
        links.add(key);
        macroLinks.push([a, b]);
      };

      for (let row = 0; row < rows; row += 1) {
        for (let col = 0; col < columns; col += 1) {
          const id = grid[row]![col] as number;
          if (col < columns - 1) connect(id, grid[row]![col + 1] as number);
          if (row < rows - 1) connect(id, grid[row + 1]![col] as number);
          if (col < columns - 1 && row < rows - 1 && Math.random() > 0.34) {
            connect(id, grid[row + 1]![col + 1] as number);
          }
          if (col < columns - 1 && row > 0 && Math.random() > 0.58) {
            connect(id, grid[row - 1]![col + 1] as number);
          }
        }
      }

      const longLinks = clampInt((rows * columns) / 2.5, 10, 28);
      for (let i = 0; i < longLinks; i += 1) {
        const left = Math.floor(Math.random() * macroNodes.length);
        const right = Math.floor(Math.random() * macroNodes.length);
        if (left === right) continue;
        const dist = Math.abs(left - right);
        if (dist < columns) continue;
        connect(left, right);
      }

      const pathCount = clampInt(columns * 0.9, 4, 10);
      for (let pathIndex = 0; pathIndex < pathCount; pathIndex += 1) {
        const ids: number[] = [];
        let row = Math.floor(Math.random() * rows);
        for (let col = 0; col < columns; col += 1) {
          if (col > 0) {
            row = clampInt(row + Math.floor(Math.random() * 3) - 1, 0, rows - 1);
          }
          ids.push(grid[row]![col] as number);
        }
        macroPaths.push({
          ids,
          speed: 0.002 + Math.random() * 0.0016,
          phase: Math.random(),
          hue: Math.random() > 0.5 ? 23 : 205,
        });
      }
    };

    const buildMiniGraphs = () => {
      miniGraphs.length = 0;
      const area = width * height;
      const graphCount = clampInt(area / 120_000, 8, 18);
      const placedCenters: Array<{ x: number; y: number }> = [];
      const minGap = Math.max(92, Math.min(width, height) * 0.12);

      for (let index = 0; index < graphCount; index += 1) {
        let centerX = width * (0.08 + Math.random() * 0.84);
        let centerY = height * (0.1 + Math.random() * 0.8);

        for (let attempt = 0; attempt < 42; attempt += 1) {
          centerX = width * (0.06 + Math.random() * 0.88);
          centerY = height * (0.08 + Math.random() * 0.84);
          const collides = placedCenters.some(
            (center) => Math.hypot(center.x - centerX, center.y - centerY) < minGap,
          );
          if (!collides) break;
        }

        placedCenters.push({ x: centerX, y: centerY });

        const scale = 0.7 + Math.random() * 0.6;
        const localRadius =
          Math.max(30, Math.min(112, Math.min(width, height) * (0.042 + Math.random() * 0.045))) * scale;
        const nodeCount = clampInt(5 + Math.random() * 9 + scale * 2, 5, 16);
        const nodes: MicroNode[] = [];
        const hues = [198, 206, 214, 24];

        for (let nodeIndex = 0; nodeIndex < nodeCount; nodeIndex += 1) {
          const angle = (nodeIndex / nodeCount) * Math.PI * 2 + Math.random() * 0.8;
          const ring = 0.42 + Math.random() * 0.74;
          const spread = localRadius * ring;
          const stretch = 0.74 + Math.random() * 0.38;
          nodes.push({
            x: Math.cos(angle) * spread,
            y: Math.sin(angle) * spread * stretch,
            z: (Math.random() - 0.5) * 180,
            vx: (Math.random() - 0.5) * 0.18,
            vy: (Math.random() - 0.5) * 0.18,
            baseRadius: 1.1 + Math.random() * 2.1,
            phase: Math.random() * Math.PI * 2,
            hue: hues[(nodeIndex + index) % hues.length] as number,
          });
        }

        const links: Array<[number, number]> = [];
        const linkSet = new Set<string>();
        for (let left = 0; left < nodes.length; left += 1) {
          const nearest = nodes
            .map((node, right) => ({
              right,
              distance:
                right === left
                  ? Number.POSITIVE_INFINITY
                  : Math.hypot(node.x - nodes[left]!.x, node.y - nodes[left]!.y),
            }))
            .sort((a, b) => a.distance - b.distance)
            .slice(0, 2);

          for (const item of nearest) {
            if (!Number.isFinite(item.distance)) continue;
            const key = edgeKey(left, item.right);
            if (linkSet.has(key)) continue;
            linkSet.add(key);
            links.push([left, item.right]);
          }
        }

        const extraLinks = clampInt(nodes.length / 3, 1, 6);
        for (let i = 0; i < extraLinks; i += 1) {
          const left = Math.floor(Math.random() * nodes.length);
          const right = Math.floor(Math.random() * nodes.length);
          if (left === right) continue;
          const key = edgeKey(left, right);
          if (linkSet.has(key)) continue;
          linkSet.add(key);
          links.push([left, right]);
        }

        const triangles: Array<[number, number, number]> = [];
        const triangleCount = clampInt(nodes.length / 7, 1, 3);
        for (let tri = 0; tri < triangleCount; tri += 1) {
          const a = Math.floor(Math.random() * nodes.length);
          const b = Math.floor(Math.random() * nodes.length);
          const c = Math.floor(Math.random() * nodes.length);
          if (a === b || b === c || a === c) continue;
          triangles.push([a, b, c]);
        }

        const adjacency = new Map<number, number[]>();
        for (const [left, right] of links) {
          adjacency.set(left, [...(adjacency.get(left) ?? []), right]);
          adjacency.set(right, [...(adjacency.get(right) ?? []), left]);
        }

        const paths: HopPath[] = [];
        const pathCount = clampInt(1 + Math.random() * 3, 1, 4);
        for (let pathIndex = 0; pathIndex < pathCount; pathIndex += 1) {
          const ids: number[] = [];
          let cursor = Math.floor(Math.random() * nodes.length);
          ids.push(cursor);
          const length = clampInt(3 + Math.random() * 3, 3, 6);
          for (let hop = 1; hop < length; hop += 1) {
            const options = (adjacency.get(cursor) ?? []).filter((candidate) => !ids.includes(candidate));
            if (options.length === 0) break;
            cursor = options[Math.floor(Math.random() * options.length)] as number;
            ids.push(cursor);
          }
          if (ids.length >= 3) {
            paths.push({
              ids,
              speed: 0.003 + Math.random() * 0.0032,
              phase: Math.random(),
              hue: Math.random() > 0.42 ? 24 : 205,
            });
          }
        }

        miniGraphs.push({
          cx: centerX,
          cy: centerY,
          vx: (Math.random() - 0.5) * 0.21,
          vy: (Math.random() - 0.5) * 0.21,
          phase: Math.random() * Math.PI * 2,
          twist: (Math.random() > 0.5 ? 1 : -1) * (0.0009 + Math.random() * 0.002),
          scale,
          depth: (Math.random() - 0.5) * 120,
          radiusLimit: localRadius * 1.24,
          pulsePhase: Math.random() * Math.PI * 2,
          nodes,
          links,
          triangles,
          paths,
        });
      }
    };

    const init = () => {
      buildMacroNetwork();
      buildMiniGraphs();
    };

    const step = () => {
      frame += 1;
      context.clearRect(0, 0, width, height);

      const bg = context.createLinearGradient(0, 0, width, height);
      bg.addColorStop(0, "rgba(242, 249, 255, 0.95)");
      bg.addColorStop(0.46, "rgba(234, 245, 255, 0.9)");
      bg.addColorStop(1, "rgba(247, 251, 255, 0.94)");
      context.fillStyle = bg;
      context.fillRect(0, 0, width, height);

      const macroProjected = macroNodes.map((node, index) => {
        const wobbleX = Math.sin(frame * 0.005 + node.phase + index * 0.16) * 12;
        const wobbleY = Math.cos(frame * 0.004 + node.phase + index * 0.11) * 9;
        return {
          x: node.baseX + wobbleX,
          y: node.baseY + wobbleY,
          hue: node.hue,
          radius: node.radius + Math.sin(frame * 0.018 + node.phase) * 0.25,
        };
      });

      for (const [left, right] of macroLinks) {
        const a = macroProjected[left];
        const b = macroProjected[right];
        if (!a || !b) continue;
        context.strokeStyle = "hsla(206, 36%, 64%, 0.16)";
        context.lineWidth = 0.8;
        context.beginPath();
        context.moveTo(a.x, a.y);
        context.lineTo(b.x, b.y);
        context.stroke();
      }

      for (const path of macroPaths) {
        const progress = (frame * path.speed + path.phase) % 1;
        const segmentCount = path.ids.length - 1;
        if (segmentCount <= 0) continue;
        const activeSegment = Math.floor(progress * segmentCount);
        const within = progress * segmentCount - activeSegment;

        for (let i = 0; i < segmentCount; i += 1) {
          const from = macroProjected[path.ids[i] as number];
          const to = macroProjected[path.ids[i + 1] as number];
          if (!from || !to) continue;
          const highlighted = i < activeSegment || i === activeSegment;
          context.strokeStyle = highlighted
            ? `hsla(${path.hue}, 92%, 56%, 0.25)`
            : "hsla(206, 36%, 65%, 0.08)";
          context.lineWidth = highlighted ? 1.25 : 0.62;
          context.beginPath();
          context.moveTo(from.x, from.y);
          context.lineTo(to.x, to.y);
          context.stroke();

          if (i === activeSegment) {
            const x = from.x + (to.x - from.x) * within;
            const y = from.y + (to.y - from.y) * within;
            context.beginPath();
            context.fillStyle = `hsla(${path.hue}, 95%, 54%, 0.9)`;
            context.arc(x, y, 2, 0, Math.PI * 2);
            context.fill();
          }
        }
      }

      macroProjected.forEach((node) => {
        context.beginPath();
        context.fillStyle = `hsla(${node.hue}, 56%, 58%, 0.34)`;
        context.arc(node.x, node.y, Math.max(0.8, node.radius), 0, Math.PI * 2);
        context.fill();
      });

      for (const graph of miniGraphs) {
        graph.cx += graph.vx + Math.sin(frame * 0.0028 + graph.phase) * 0.08;
        graph.cy += graph.vy + Math.cos(frame * 0.0025 + graph.phase) * 0.08;
        if (graph.cx < 30 || graph.cx > width - 30) graph.vx *= -1;
        if (graph.cy < 30 || graph.cy > height - 30) graph.vy *= -1;

        const angle = frame * graph.twist + graph.phase;
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);

        const projected = graph.nodes.map((node) => {
          node.x += node.vx + Math.sin(frame * 0.012 + node.phase) * 0.03;
          node.y += node.vy + Math.cos(frame * 0.013 + node.phase) * 0.03;
          if (Math.hypot(node.x, node.y) > graph.radiusLimit) {
            node.vx *= -1;
            node.vy *= -1;
            node.x *= 0.97;
            node.y *= 0.97;
          }

          const rotatedX = node.x * cos - node.y * sin;
          const rotatedY = node.x * sin + node.y * cos;
          const z = graph.depth + node.z + Math.sin(frame * 0.018 + node.phase) * 24;
          const fov = 620;
          const perspective = fov / (fov + z + 360);
          return {
            x: graph.cx + rotatedX * perspective * graph.scale,
            y: graph.cy + rotatedY * perspective * graph.scale,
            scale: perspective,
            hue: node.hue,
            radius: node.baseRadius * (1 + Math.sin(frame * 0.02 + node.phase) * 0.2),
          };
        });

        for (const [left, right] of graph.links) {
          const a = projected[left];
          const b = projected[right];
          if (!a || !b) continue;
          const alpha = Math.min(a.scale, b.scale) * 0.27;
          context.strokeStyle = `hsla(206, 42%, 59%, ${alpha})`;
          context.lineWidth = 0.45 + Math.min(a.scale, b.scale) * 1.1;
          context.beginPath();
          context.moveTo(a.x, a.y);
          context.lineTo(b.x, b.y);
          context.stroke();
        }

        for (const [aId, bId, cId] of graph.triangles) {
          const a = projected[aId];
          const b = projected[bId];
          const c = projected[cId];
          if (!a || !b || !c) continue;
          const alpha = Math.min(a.scale, b.scale, c.scale) * 0.2;
          context.fillStyle = `hsla(213, 64%, 71%, ${alpha * 0.18})`;
          context.strokeStyle = `hsla(25, 93%, 56%, ${alpha * 0.84})`;
          context.lineWidth = 0.55 + Math.min(a.scale, b.scale, c.scale) * 0.82;
          context.beginPath();
          context.moveTo(a.x, a.y);
          context.lineTo(b.x, b.y);
          context.lineTo(c.x, c.y);
          context.closePath();
          context.fill();
          context.stroke();
        }

        for (const path of graph.paths) {
          const progress = (frame * path.speed + path.phase) % 1;
          const segmentCount = path.ids.length - 1;
          if (segmentCount <= 0) continue;
          const activeSegment = Math.floor(progress * segmentCount);
          const within = progress * segmentCount - activeSegment;

          for (let i = 0; i < segmentCount; i += 1) {
            const from = projected[path.ids[i] as number];
            const to = projected[path.ids[i + 1] as number];
            if (!from || !to) continue;
            const highlighted = i < activeSegment || i === activeSegment;
            context.strokeStyle = highlighted
              ? `hsla(${path.hue}, 92%, 55%, 0.34)`
              : "hsla(206, 34%, 64%, 0.08)";
            context.lineWidth = highlighted ? 1.35 : 0.68;
            context.beginPath();
            context.moveTo(from.x, from.y);
            context.lineTo(to.x, to.y);
            context.stroke();

            if (i === activeSegment) {
              const px = from.x + (to.x - from.x) * within;
              const py = from.y + (to.y - from.y) * within;
              context.beginPath();
              context.fillStyle = `hsla(${path.hue}, 95%, 54%, 0.9)`;
              context.arc(px, py, 2.2, 0, Math.PI * 2);
              context.fill();
            }
          }
        }

        const pulse = (Math.sin(frame * 0.014 + graph.pulsePhase) + 1) * 0.5;
        context.strokeStyle = `hsla(204, 70%, 68%, ${0.06 + pulse * 0.08})`;
        context.lineWidth = 0.82;
        context.beginPath();
        context.arc(graph.cx, graph.cy, (16 + pulse * 24) * graph.scale, 0, Math.PI * 2);
        context.stroke();

        projected.forEach((point) => {
          const radius = Math.max(0.8, point.radius * point.scale * 3.05);
          context.beginPath();
          context.fillStyle = `hsla(${point.hue}, 58%, 56%, ${0.22 + point.scale * 0.55})`;
          context.arc(point.x, point.y, radius, 0, Math.PI * 2);
          context.fill();
        });
      }

      raf = window.requestAnimationFrame(step);
    };

    resize();
    init();
    step();

    const onResize = () => {
      resize();
      init();
    };
    window.addEventListener("resize", onResize);

    return () => {
      window.cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
    };
  }, []);

  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden">
      <canvas ref={canvasRef} className="h-full w-full opacity-95" />
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_15%_10%,rgba(116,188,242,0.18),transparent_42%),radial-gradient(circle_at_82%_16%,rgba(255,165,88,0.14),transparent_36%),radial-gradient(circle_at_60%_88%,rgba(100,168,230,0.12),transparent_42%)]" />
      <div className="absolute inset-0 bg-[radial-gradient(circle,rgba(129,160,204,0.34)_1px,transparent_1.4px)] bg-[size:24px_24px]" />
      <div className="absolute inset-0 bg-[radial-gradient(circle,rgba(242,164,95,0.22)_1px,transparent_1.2px)] bg-[size:64px_64px] bg-[position:16px_12px]" />
    </div>
  );
}
