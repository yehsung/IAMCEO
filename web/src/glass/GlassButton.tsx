// glass/GlassButton.tsx — 유리 버튼(랜딩 설계 §3 · §5). 서버·클라 어디서나(훅 없음).
// <GlassButton variant="primary" size="m" onClick={send}>보내기</GlassButton>
//   variant primary(보라 빛 유리 — 한 화면에 하나) | glass(투명 유리, 보조) | ghost(글자만)
//   size    l 52 · m 44 · s 32(누를 자리 44 보장)
// href 가 있으면 <a>, 없으면 <button>. 눌림 = scale .97 → 스프링 복귀. 끝 화살표 없음.
// primary·glass 는 포인터 스페큘러(GlassFx — pointer:fine · 감속 아님일 때만)가 배경 첫 층을 밝힌다.
import type { ReactNode, Ref } from 'react';
import { GlassFx } from './GlassFx';

export type GlassButtonVariant = 'primary' | 'glass' | 'ghost';
export type GlassButtonSize = 'l' | 'm' | 's';

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

/** 버튼 클래스만 필요할 때(링크·다른 컴포넌트에 입히기). */
export function glassButtonClass(variant: GlassButtonVariant = 'glass', size: GlassButtonSize = 'l', extra?: string): string {
  return cx('gbtn', `gbtn--${variant}`, `gbtn--${size}`, extra);
}

export interface GlassButtonProps {
  variant?: GlassButtonVariant;
  size?: GlassButtonSize;
  href?: string;
  onClick?: () => void;
  external?: boolean;
  disabled?: boolean;
  ariaLabel?: string;
  className?: string;
  children: ReactNode;
  id?: string;
  type?: 'button' | 'submit';
  ariaExpanded?: boolean;
  ariaControls?: string;
  ariaDescribedBy?: string;
  ariaPressed?: boolean;
  title?: string;
  ref?: Ref<HTMLElement>;
}

export function GlassButton({
  variant = 'glass',
  size = 'l',
  href,
  onClick,
  external,
  disabled,
  ariaLabel,
  className,
  children,
  id,
  type = 'button',
  ariaExpanded,
  ariaControls,
  ariaDescribedBy,
  ariaPressed,
  title,
  ref,
}: GlassButtonProps) {
  const cls = glassButtonClass(variant, size, className);
  const fx = variant === 'ghost' ? null : <GlassFx specular />;
  if (href !== undefined) {
    if (disabled) {
      return (
        <span ref={ref as Ref<HTMLSpanElement>} id={id} role="link" aria-disabled="true" aria-label={ariaLabel} className={cls}>
          {children}
        </span>
      );
    }
    return (
      <a
        ref={ref as Ref<HTMLAnchorElement>}
        id={id}
        href={href}
        onClick={onClick}
        target={external ? '_blank' : undefined}
        rel={external ? 'noopener noreferrer' : undefined}
        aria-label={ariaLabel}
        aria-expanded={ariaExpanded}
        aria-controls={ariaControls}
        aria-describedby={ariaDescribedBy}
        title={title}
        className={cls}
      >
        {children}
        {fx}
      </a>
    );
  }
  return (
    <button
      ref={ref as Ref<HTMLButtonElement>}
      id={id}
      type={type}
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      aria-expanded={ariaExpanded}
      aria-controls={ariaControls}
      aria-describedby={ariaDescribedBy}
      aria-pressed={ariaPressed}
      title={title}
      className={cls}
    >
      {children}
      {fx}
    </button>
  );
}
