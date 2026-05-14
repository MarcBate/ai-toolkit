import React, { useRef, useEffect, useState, ReactNode } from 'react';
import { isVideo, isAudio } from '@/utils/basic';

interface SampleImageCardProps {
  imageUrl: string;
  alt: string;
  numSamples: number;
  sampleImages: string[];
  children?: ReactNode;
  className?: string;
  onDelete?: () => void;
  onClick?: () => void;
  /** pass your scroll container element (e.g. containerRef.current) */
  observerRoot?: Element | null;
  /** optional: tweak pre-load buffer */
  rootMargin?: string; // default '200px 0px'
  stepLabel?: number | string;
}

const SampleImageCard: React.FC<SampleImageCardProps> = ({
  imageUrl,
  alt,
  numSamples,
  sampleImages,
  children,
  className = '',
  onClick = () => {},
  observerRoot = null,
  rootMargin = '200px 0px',
  stepLabel,
}) => {
  const cardRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [isVisible, setIsVisible] = useState(false);
  const [loaded, setLoaded] = useState(false);

  // Observe both enter and exit
  useEffect(() => {
    const el = cardRef.current;
    if (!el) return;

    const observer = new IntersectionObserver(
      entries => {
        for (const entry of entries) {
          if (entry.target === el) {
            setIsVisible(entry.isIntersecting);
          }
        }
      },
      {
        root: observerRoot ?? null,
        threshold: 0.01,
        rootMargin,
      },
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, [observerRoot, rootMargin]);

  const handleLoad = () => setLoaded(true);

  return (
    <div className={`flex flex-col ${className}`}>
      <div ref={cardRef} className="relative w-full cursor-pointer" style={{ paddingBottom: '100%' }} onClick={onClick}>
        <div className="absolute inset-0 rounded-t-lg shadow-md" style={{ containerType: 'size' }}>
          {isVisible ? (
            isAudio(imageUrl) ? (
              <div className="w-full h-full flex items-center justify-center bg-gray-900">
                <img
                  src={`/api/audio/art/${encodeURIComponent(imageUrl)}`}
                  alt={alt}
                  className="w-full h-full object-cover"
                  onError={e => {
                    (e.target as HTMLImageElement).style.display = 'none';
                  }}
                />
              </div>
            ) : isVideo(imageUrl) ? (
              <video
                ref={videoRef}
                src={`/api/img/${encodeURIComponent(imageUrl)}`}
                className="w-full h-full object-cover"
                preload="none"
                onLoad={handleLoad}
                playsInline
                muted
                loop
                autoPlay
                controls={false}
              />
            ) : (
              <img
                src={`/api/img/${encodeURIComponent(imageUrl)}`}
                alt={alt}
                onLoad={handleLoad}
                loading="lazy"
                decoding="async"
                className={`w-full h-full object-cover transition-opacity duration-300 ${
                  loaded ? 'opacity-100' : 'opacity-0'
                }`}
              />
            )
          ) : null}

          {children && isVisible && <div className="absolute inset-0 flex items-center justify-center">{children}</div>}
          {stepLabel !== undefined && (
            <div
              className="absolute top-0 left-0 z-10 text-white font-bold leading-none select-none pointer-events-none"
              style={{
                fontSize: '20cqmin',
                padding: '0.1em 0.15em',
                textShadow: '0 0 6px rgba(0,0,0,1), 0 1px 4px rgba(0,0,0,0.9)',
              }}
            >
              {stepLabel}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default SampleImageCard;
