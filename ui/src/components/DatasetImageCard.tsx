import React, { useRef, useEffect, useState, ReactNode, KeyboardEvent } from 'react';
import { FaTrashAlt, FaEye, FaEyeSlash } from 'react-icons/fa';
import { openConfirm } from './ConfirmModal';
import classNames from 'classnames';
import { apiClient } from '@/utils/api';
import AudioPlayer from './AudioPlayer';
import { isVideo, isAudio } from '@/utils/basic';

interface DatasetImageCardProps {
  imageUrl: string;
  alt: string;
  isAutoCaptioning: boolean;
  children?: ReactNode;
  className?: string;
  onDelete?: () => void;
  onCaptionSave?: (newCaption: string, imageUrl: string) => void;
  /** When provided (even as empty string), the caption is considered pre-loaded and no fetch is issued. */
  initialCaption?: string;
  isHighlighted?: boolean;
  highlightText?: string;
  highlightCharIndex?: number;
  /** Increment this to collapse the caption on cards that are not currently highlighted (e.g. on Find navigation). */
  resetEditKey?: number;
}

const DatasetImageCard: React.FC<DatasetImageCardProps> = ({
  imageUrl,
  alt,
  isAutoCaptioning,
  children,
  className = '',
  onDelete = () => {},
  onCaptionSave = () => {},
  initialCaption,
  isHighlighted = false,
  highlightText = '',
  highlightCharIndex = -1,
  resetEditKey,
}) => {
  const cardRef = useRef<HTMLDivElement>(null);
  const textAreaRef = useRef<HTMLTextAreaElement>(null);
  const [isVisible, setIsVisible] = useState<boolean>(false);
  const [inViewport, setInViewport] = useState<boolean>(false);
  const [loaded, setLoaded] = useState<boolean>(false);
  const abortControllerRef = useRef<AbortController | null>(null);
  // If initialCaption was explicitly provided (even as ''), the caption is already known —
  // no need to fetch. Only fetch when the prop is absent (undefined).
  const [isCaptionLoaded, setIsCaptionLoaded] = useState<boolean>(initialCaption !== undefined);
  const [caption, setCaption] = useState<string>(initialCaption ?? '');
  const [savedCaption, setSavedCaption] = useState<string>(initialCaption ?? '');
  const [isEditing, setIsEditing] = useState<boolean>(false);
  const isGettingCaption = useRef<boolean>(false);

  useEffect(() => {
    setCaption(initialCaption ?? '');
    setSavedCaption(initialCaption ?? '');
    setIsCaptionLoaded(initialCaption !== undefined);
  }, [initialCaption]);

  useEffect(() => {
    if (isHighlighted && highlightText && highlightCharIndex !== -1 && isCaptionLoaded) {
      // Focus and highlight the text in the textarea.
      // NOTE: highlightText is intentionally excluded from the deps array — including it would
      // re-run this effect on every keystroke in the Find input, stealing focus mid-word.
      // The effect re-runs on navigation (highlightCharIndex changes) which is the right trigger.
      if (textAreaRef.current) {
        textAreaRef.current.focus();
        textAreaRef.current.setSelectionRange(
            highlightCharIndex,
            highlightCharIndex + highlightText.length
        );
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isHighlighted, highlightCharIndex, isCaptionLoaded]);

  // When the parent navigates to a new find result it increments resetEditKey.
  // Collapse any card that is no longer the active match so only one caption
  // is expanded at a time.
  useEffect(() => {
    if (resetEditKey === undefined) return;
    if (!isHighlighted) {
      setIsEditing(false);
      textAreaRef.current?.blur();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetEditKey]);

  const fetchCaption = async () => {
    if (isGettingCaption.current || isCaptionLoaded) return;
    isGettingCaption.current = true;
    abortControllerRef.current?.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;
    apiClient
      .post(`/api/caption/get`, { imgPath: imageUrl }, { signal: controller.signal })
      .then(res => res.data)
      .then(data => {
        console.log('Caption fetched:', data);
        if (data) {
          data = `${data}`;
        }
        setCaption(data || '');
        setSavedCaption(data || '');
        setIsCaptionLoaded(true);
      })
      .catch(error => {
        if (controller.signal.aborted) return;
        console.error('Error fetching caption:', error);
      })
      .finally(() => {
        if (abortControllerRef.current === controller) {
          abortControllerRef.current = null;
        }
      });
  };

  const saveCaption = (valueToSave?: string) => {
    const targetCaption = (valueToSave !== undefined ? valueToSave : caption).trim();
    if (targetCaption === savedCaption) return;

    setSavedCaption(targetCaption);

    apiClient
      .post('/api/img/caption', { imgPath: imageUrl, caption: targetCaption })
      .then(res => res.data)
      .then(data => {
        console.log('Caption saved:', data);
        onCaptionSave(targetCaption, imageUrl);
      })
      .catch(error => {
        console.error('Error saving caption:', error);
        setSavedCaption(prev => prev === targetCaption ? caption.trim() : prev);
      });
  };

  useEffect(() => {
    if (inViewport && isVisible) {
      fetchCaption();
    }
  }, [inViewport, isVisible, isCaptionLoaded]);

  // Poll for caption updates every 5 seconds while auto-captioning
  useEffect(() => {
    if (!isAutoCaptioning || !inViewport || !isVisible) return;
    const interval = setInterval(() => {
      // Reset so fetchCaption will re-fetch
      setIsCaptionLoaded(false);
    }, 5000);
    return () => clearInterval(interval);
  }, [isAutoCaptioning, inViewport, isVisible]);

  useEffect(() => {
    const observer = new IntersectionObserver(
      entries => {
        if (entries[0].isIntersecting) {
          setInViewport(true);
          if (!isVisible) {
            setIsVisible(true);
          }
        } else {
          setInViewport(false);
          abortControllerRef.current?.abort();
        }
      },
      { threshold: 0.1 },
    );

    if (cardRef.current) {
      observer.observe(cardRef.current);
    }

    return () => {
      observer.disconnect();
    };
  }, []);

  const toggleVisibility = (): void => {
    setIsVisible(prev => !prev);
    if (!isVisible && !isCaptionLoaded) {
      fetchCaption();
    }
  };

  const handleLoad = (): void => {
    setLoaded(true);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      saveCaption(e.currentTarget.value);
      setIsEditing(false);
      (e.target as HTMLTextAreaElement).blur();
    }
  };

  const isCaptionCurrent = caption.trim() === savedCaption;

  // Start hidden so AudioPlayer doesn't mount (and load audio/art) for every visible card at once.
  const [showAudioPlayer, setShowAudioPlayer] = useState(false);

  const isItAVideo = isVideo(imageUrl);
  const isItAudio = isAudio(imageUrl);
  const isItImage = !isItAVideo && !isItAudio;

  const effectivelyEditing = isEditing || isHighlighted;

  return (
    <div className={`flex flex-col ${className}`}>
      <div
        ref={cardRef}
        className="relative w-full"
        style={{ paddingBottom: '100%' }}
      >
        <div className="absolute inset-0 rounded-t-lg shadow-md">
          {/* Render content once the card has ever been in view (isVisible is sticky-true).
              We intentionally do NOT gate on inViewport here — doing so causes images at
              the last row to unmount/remount as the user hovers near the viewport edge,
              producing the "endless flash loop" reported when scrolling to the bottom. */}
          {isVisible && (
            <>
              {isItAVideo && (
                <video
                  src={`/api/img/${encodeURIComponent(imageUrl)}`}
                  className={`w-full h-full object-contain`}
                  autoPlay={false}
                  loop
                  muted
                  controls
                />
              )}
              {isItAudio && !showAudioPlayer && (
                <div
                  className="w-full h-full cursor-pointer flex flex-col items-center justify-center gap-2 bg-gray-900 text-gray-400 hover:bg-gray-800 hover:text-gray-200 transition-colors"
                  onClick={() => setShowAudioPlayer(true)}
                  title="Click to play"
                >
                  <div className="text-5xl select-none">♪</div>
                  <div className="text-xs px-2 w-full text-center truncate">
                    {imageUrl.replace(/^.*[\\/]/, '')}
                  </div>
                  <div className="text-xs text-gray-500">Click to play</div>
                </div>
              )}
              {isItAudio && showAudioPlayer && (
                <AudioPlayer
                  src={`/api/img/${encodeURIComponent(imageUrl)}`}
                  title={imageUrl.replace(/^.*[\\/]/, '')}
                />
              )}
              {isItImage && (
                <img
                  src={`/api/img/${encodeURIComponent(imageUrl)}`}
                  alt={alt}
                  onLoad={handleLoad}
                  className={`w-full h-full object-contain transition-opacity duration-300 ${
                    loaded ? 'opacity-100' : 'opacity-0'
                  }`}
                />
              )}
            </>
          )}
          {children && <div className="absolute inset-0 flex items-center justify-center">{children}</div>}
          <div className="absolute top-1 right-1 flex space-x-2 z-10">
            <button
              className="bg-gray-800 rounded-full p-2"
              onClick={() => {
                openConfirm({
                  title: `Delete ${isItAVideo ? 'video' : 'image'}`,
                  message: `Are you sure you want to delete this ${isItAVideo ? 'video' : 'image'}? This action cannot be undone.`,
                  type: 'warning',
                  confirmText: 'Delete',
                  onConfirm: () => {
                    apiClient
                      .post('/api/img/delete', { imgPath: imageUrl })
                      .then(() => {
                        console.log('Image deleted:', imageUrl);
                        onDelete();
                      })
                      .catch(error => {
                        console.error('Error deleting image:', error);
                      });
                  },
                });
              }}
            >
              <FaTrashAlt />
            </button>
          </div>
        </div>
      </div>
      <div
        className={classNames('w-full p-2 bg-gray-800 text-white text-sm rounded-b-lg', {
          'border-blue-500 border-2': !isCaptionCurrent,
          'border-transparent border-2': isCaptionCurrent,
          'h-[75px] overflow-hidden': !effectivelyEditing,
          'min-h-[75px] z-10': effectivelyEditing,
        })}
      >
        {/* Same sticky-visible gate as the image — avoid using inViewport here to prevent
            the caption form from unmounting when the card briefly leaves the viewport edge. */}
        {isVisible && (isCaptionLoaded || caption) && (
          <form
            onSubmit={e => {
              e.preventDefault();
              saveCaption();
            }}
            onBlur={e => {
              saveCaption(e.currentTarget.querySelector('textarea')?.value);
              setIsEditing(false);
            }}
          >
            <textarea
              ref={textAreaRef}
              className={classNames("w-full bg-transparent resize-none outline-none focus:ring-0 focus:outline-none", {
                'opacity-50 cursor-not-allowed': isAutoCaptioning,
              })}
              style={effectivelyEditing ? { fieldSizing: 'content' } as any : {}}
              value={caption}
              rows={effectivelyEditing ? undefined : 3}
              readOnly={isAutoCaptioning}
              onChange={e => setCaption(e.target.value)}
              onKeyDown={handleKeyDown}
              onFocus={() => setIsEditing(true)}
            />
          </form>
        )}
        {!isCaptionLoaded && !caption && (
          <div className="w-full h-full flex items-center justify-center text-gray-400">Loading caption...</div>
        )}
      </div>
    </div>
  );
};

export default DatasetImageCard;
