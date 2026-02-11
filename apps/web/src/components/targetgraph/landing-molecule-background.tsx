"use client";

import { useEffect, useRef } from "react";

type Particle = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  hue: number;
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
    const total = 56;

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
          vx: (Math.random() - 0.5) * 0.22,
          vy: (Math.random() - 0.5) * 0.22,
          r: 1.6 + Math.random() * 2.2,
          hue: i % 5 === 0 ? 29 : 252,
        });
      }
    };

    const step = () => {
      frame += 1;
      context.clearRect(0, 0, width, height);

      const bg = context.createLinearGradient(0, 0, width, height);
      bg.addColorStop(0, "rgba(78, 60, 210, 0.15)");
      bg.addColorStop(0.55, "rgba(56, 128, 244, 0.12)");
      bg.addColorStop(1, "rgba(245, 139, 46, 0.10)");
      context.fillStyle = bg;
      context.fillRect(0, 0, width, height);

      for (const p of particles) {
        p.x += p.vx;
        p.y += p.vy;

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
          if (dist > 130) continue;
          const alpha = (1 - dist / 130) * 0.22;
          context.strokeStyle = `hsla(246, 73%, 58%, ${alpha})`;
          context.lineWidth = dist < 70 ? 1.2 : 0.7;
          context.beginPath();
          context.moveTo(a.x, a.y);
          context.lineTo(b.x, b.y);
          context.stroke();
        }
      }

      particles.forEach((p, idx) => {
        context.beginPath();
        context.fillStyle = p.hue === 29 ? "rgba(242, 138, 46, 0.72)" : "rgba(96, 90, 232, 0.66)";
        context.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        context.fill();

        if (idx % 11 === 0) {
          const pulse = 5 + Math.sin(frame * 0.02 + idx) * 1.2;
          context.strokeStyle = "rgba(96, 90, 232, 0.32)";
          context.lineWidth = 0.9;
          drawHex(context, p.x, p.y, pulse);
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
      <canvas ref={canvasRef} className="h-full w-full opacity-90" />
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_14%_8%,rgba(255,255,255,0.6),transparent_42%),radial-gradient(circle_at_86%_14%,rgba(255,255,255,0.34),transparent_32%)]" />
    </div>
  );
}
