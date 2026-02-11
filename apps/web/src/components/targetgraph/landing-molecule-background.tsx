"use client";

import { useEffect, useRef } from "react";

type Particle = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  drift: number;
  r: number;
  z: number;
  pulsePhase: number;
  tone: "amber" | "violet";
};

function drawHex(ctx: CanvasRenderingContext2D, x: number, y: number, radius: number) {
  ctx.beginPath();
  for (let i = 0; i < 6; i += 1) {
    const angle = (Math.PI / 3) * i - Math.PI / 6;
    const px = x + radius * Math.cos(angle);
    const py = y + radius * Math.sin(angle);
    if (i === 0) {
      ctx.moveTo(px, py);
    } else {
      ctx.lineTo(px, py);
    }
  }
  ctx.closePath();
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

    const particles: Particle[] = [];
    const total = 128;

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

    const init = () => {
      particles.length = 0;
      for (let i = 0; i < total; i += 1) {
        particles.push({
          x: Math.random() * width,
          y: Math.random() * height,
          vx: (Math.random() - 0.5) * 0.44,
          vy: (Math.random() - 0.5) * 0.44,
          drift: 0.62 + Math.random() * 1.2,
          r: 1.4 + Math.random() * 2.6,
          z: 0.65 + Math.random() * 0.95,
          pulsePhase: Math.random() * Math.PI * 2,
          tone: i % 3 === 0 ? "amber" : "violet",
        });
      }
    };

    const step = () => {
      frame += 1;
      context.clearRect(0, 0, width, height);

      const bg = context.createLinearGradient(0, 0, width, height);
      bg.addColorStop(0, "rgba(255, 172, 94, 0.18)");
      bg.addColorStop(0.5, "rgba(250, 147, 58, 0.14)");
      bg.addColorStop(1, "rgba(162, 102, 214, 0.09)");
      context.fillStyle = bg;
      context.fillRect(0, 0, width, height);

      for (const p of particles) {
        const orbit = Math.sin(frame * 0.006 + p.pulsePhase) * p.drift;
        p.x += p.vx * p.z + orbit * 0.18;
        p.y += p.vy * p.z + Math.cos(frame * 0.004 + p.pulsePhase) * 0.14;

        if (p.x < 0 || p.x > width) p.vx *= -1;
        if (p.y < 0 || p.y > height) p.vy *= -1;
      }

      for (let i = 0; i < particles.length; i += 1) {
        const a = particles[i];
        if (!a) continue;
        for (let j = i + 1; j < particles.length; j += 1) {
          const b = particles[j];
          if (!b) continue;
          const dx = a.x - b.x;
          const dy = a.y - b.y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist > 158) continue;
          const alpha = (1 - dist / 158) * 0.3;
          context.strokeStyle =
            i % 3 === 0
              ? `hsla(261, 58%, 63%, ${alpha})`
              : `hsla(30, 93%, 58%, ${alpha})`;
          context.lineWidth = dist < 80 ? 1.25 : 0.72;
          context.beginPath();
          context.moveTo(a.x, a.y);
          context.lineTo(b.x, b.y);
          context.stroke();
        }
      }

      particles.forEach((p, idx) => {
        const pulse = 1 + Math.sin(frame * 0.026 + p.pulsePhase) * 0.22;
        context.beginPath();
        context.fillStyle =
          p.tone === "amber" ? "rgba(243, 137, 44, 0.76)" : "rgba(123, 86, 218, 0.68)";
        context.arc(p.x, p.y, p.r * pulse * p.z, 0, Math.PI * 2);
        context.fill();

        if (idx % 9 === 0) {
          const ring = 4.8 + Math.sin(frame * 0.018 + idx) * 1.6;
          context.strokeStyle =
            p.tone === "amber" ? "rgba(243, 137, 44, 0.34)" : "rgba(123, 86, 218, 0.3)";
          context.lineWidth = 0.9;
          drawHex(context, p.x, p.y, ring);
          context.stroke();
        }
      });

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
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_14%_8%,rgba(255,243,226,0.78),transparent_42%),radial-gradient(circle_at_82%_16%,rgba(255,228,196,0.52),transparent_34%)]" />
    </div>
  );
}
