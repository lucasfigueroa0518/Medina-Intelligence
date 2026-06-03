import Image from 'next/image';

interface MedinaLogoProps {
  size?: number;
  className?: string;
}

export function MedinaLogo({ size = 32, className = '' }: MedinaLogoProps) {
  return (
    <Image
      src="/favicon.svg"
      alt="Medina Intelligence"
      width={size}
      height={size}
      className={className}
    />
  );
}
