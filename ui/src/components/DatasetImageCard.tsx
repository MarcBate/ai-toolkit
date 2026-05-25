import React, { useEffect, useState, ReactNode, KeyboardEvent, useRef } from 'react';
import { FaTrashAlt } from 'react-icons/fa';
import { openConfirm } from './ConfirmModal';
import classNames from 'classnames';
import { apiClient } from '@/utils/api';
import AudioPlayer from './AudioPlayer';
import { isVideo, isAudio } from '@/utils/basic';
import useCaptionBatch, { setCachedCaption } from '@/hooks/useCaptionBatch';

interface DatasetImageCardProps {
  imageUrl: string;
  alt: string;
  isAutoCaptioning: boolean;
  children?: ReactNode;
  className?: string;
  onDelete?: () => void;
  onCaptionSave?: (newCaption: string, imageUrl: string) => void;
  onImageClick?: () => void;
  /** When provided (even as empty string), the caption is considered pre-loaded and no fetch is issued. */
  initialCaption?: string;
  captionRefreshKey?: number;
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
  onCaptionSave,
  onImageClick,
  initialCaption,
  captionRefreshKey = 0,
  isHighlighted = false,
  highlightText = '',
  highlightCharIndex = -1,
  resetEditKey,
}) => {
  const textAreaRef = useRef<HTMLTextAreaElement>(null);
  const [loaded, setLoaded] = useState<boolean>(false);
  const [showAudioPlayer, setShowAudioPlayer] = useState(false);
  const [pollTick, setPollTick] = useState(0);
  const [isEditing, setIsEditing] = useState<boolean>(false);

  const combinedRefreshKey = captionRefreshKey + pollTick;
  const { caption: fetchedCaption, isLoaded: isCaptionLoaded } = useCaptionBatch(imageUrl, combinedRefreshKey);

  const [caption, setCaption] = useState<string>(initialCaption ?? '');
  const [savedCaption, setSavedCaption] = useState<string>((initialCaption ?? '').trim());
  const dirtyRef = useRef<boolean>(false);

  // Sync from fetched caption, but don't clobber unsaved local edits.
  useEffect(() => {
    if (!isCaptionLoaded) return;
    if (dirtyRef.current) return;
    setCaption(fetchedCaption);
    setSavedCaption(fetchedCaption.trim());
  }, [fetchedCaption, isCaptionLoaded]);

  // If initialCaption changes externally (e.g. after find/replace), sync it.
  useEffect(() => {
    if (initialCaption === undefined) return;
    if (dirtyRef.current) return;
    setCaption(initialCaption);
    setSavedCaption(initialCaption.trim());
  }, [initialCaption]);

  // Poll while auto-captioning so backend-written captions show up.
  useEffect(() => {
    if (!isAutoCaptioning) return;
    const interval = setInterval(() => setPollTick(t => t + 1), 5000);
    return () => clearInterval(interval);
  }, [isAutoCaptioning]);

  useEffect(() => {
    if (isHighlighted && highlightText && highlightCharIndex !== -1 && effectivelyLoaded) {
      if (textAreaRef.current) {
        textAreaRef.current.focus();
        textAreaRef.current.setSelectionRange(highlightCharIndex, highlightCharIndex + highlightText.length);
      }
    }
    // NOTE: highlightText excluded from deps intentionally — see comment on resetEditKey effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isHighlighted, highlightCharIndex]);

  // Collapse non-highlighted cards on Find navigation.
  useEffect(() => {
    if (resetEditKey === undefined) return;
    if (!isHighlighted) {
      setIsEditing(false);
      textAreaRef.current?.blur();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetEditKey]);

  const saveCaption = (valueToSave?: string) => {
    const trimmedCaption = (valueToSave !== undefined ? valueToSave : caption).trim();
    if (trimmedCaption === savedCaption) {
      dirtyRef.current = false;
      return;
    }
    setSavedCaption(trimmedCaption);
    setCachedCaption(imageUrl, trimmedCaption);
    dirtyRef.current = false;
    apiClient
      .post('/api/img/caption', { imgPath: imageUrl, caption: trimmedCaption })
      .then(() => {
        onCaptionSave?.(trimmedCaption, imageUrl);
      })
      .catch(error => {
        console.error('Error saving caption:', error);
      });
  };

  // Save any pending edit if the card unmounts (e.g. scrolled out of the virtualized window).
  const latestRef = useRef({ caption, savedCaption, imageUrl });
  useEffect(() => {
    latestRef.current = { caption, savedCaption, imageUrl };
  });
  useEffect(() => {
    return () => {
      if (!dirtyRef.current) return;
      const { caption: c, savedCaption: s, imageUrl: url } = latestRef.current;
      const trimmed = c.trim();
      if (trimmed === s) return;
      apiClient
        .post('/api/img/caption', { imgPath: url, caption: trimmed })
        .then(() => setCachedCaption(url, trimmed))
        .catch(err => console.error('Error saving caption on unmount:', err));
    };
  }, []);

  const handleLoad = (): void => setLoaded(true);

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      saveCaption(e.currentTarget.value);
      setIsEditing(false);
      (e.target as HTMLTextAreaElement).blur();
    }
  };

  const handleCaptionChange = (value: string) => {
    dirtyRef.current = value.trim() !== savedCaption;
    setCaption(value);
  };

  const isCaptionCurrent = caption.trim() === savedCaption;
  const effectivelyLoaded = isCaptionLoaded || initialCaption !== undefined;

  const isItAVideo = isVideo(imageUrl);
  const isItAudio = isAudio(imageUrl);
  const isItImage = !isItAVideo && !isItAudio;

  const effectivelyEditing = isEditing || isHighlighted;

  return (
    <div className={`flex flex-col ${className}`}>
      <div className="relative w-full" style={{ paddingBottom: '100%' }}>
        <div className="absolute inset-0 rounded-t-lg shadow-md">
          {isItAVideo && (
            <video
              src={`/api/img/${encodeURIComponent(imageUrl)}`}
              className="w-full h-full object-contain"
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
            <AudioPlayer src={`/api/img/${encodeURIComponent(imageUrl)}`} title={imageUrl.replace(/^.*[\\/]/, '')} />
          )}
          {isItImage && (
            <img
              src={`/api/img/${encodeURIComponent(imageUrl)}`}
              alt={alt}
              onLoad={handleLoad}
              onClick={onImageClick}
              className={classNames('w-full h-full object-contain transition-opacity duration-300', {
                'opacity-100': loaded,
                'opacity-0': !loaded,
                'cursor-zoom-in': !!onImageClick,
              })}
            />
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
        {effectivelyLoaded ? (
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
              className={classNames('w-full bg-transparent resize-none outline-none focus:ring-0 focus:outline-none', {
                'opacity-50 cursor-not-allowed': isAutoCaptioning,
              })}
              style={effectivelyEditing ? ({ fieldSizing: 'content' } as any) : {}}
              value={caption}
              rows={effectivelyEditing ? undefined : 3}
              readOnly={isAutoCaptioning}
              onChange={e => handleCaptionChange(e.target.value)}
              onKeyDown={handleKeyDown}
              onFocus={() => setIsEditing(true)}
            />
          </form>
        ) : (
          <div className="w-full h-full flex items-center justify-center text-gray-400">Loading caption...</div>
        )}
      </div>
    </div>
  );
};

export default DatasetImageCard;
