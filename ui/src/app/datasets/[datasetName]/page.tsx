'use client';

import { useEffect, useState, use, useMemo } from 'react';
import { LuImageOff, LuLoader, LuBan } from 'react-icons/lu';
import { FaChevronLeft } from 'react-icons/fa';
import DatasetImageCard from '@/components/DatasetImageCard';
import { Button } from '@headlessui/react';
import AddImagesModal, { openImagesModal } from '@/components/AddImagesModal';
import { TopBar, MainContent } from '@/components/layout';
import { apiClient } from '@/utils/api';
import FullscreenDropOverlay from '@/components/FullscreenDropOverlay';

export default function DatasetPage({ params }: { params: { datasetName: string } }) {
  const [imgList, setImgList] = useState<{ img_path: string; caption: string }[]>([]);
  const usableParams = use(params as any) as { datasetName: string };
  const datasetName = usableParams.datasetName;
  const [status, setStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [filter, setFilter] = useState('');
  const [filterHistory, setFilterHistory] = useState<string[]>([]);
  const [showHistory, setShowHistory] = useState(false);

  useEffect(() => {
    const savedHistory = localStorage.getItem('filterHistory');
    if (savedHistory) {
      try {
        setFilterHistory(JSON.parse(savedHistory));
      } catch (e) {
        console.error('Error parsing filter history:', e);
      }
    }
  }, []);

  const addToHistory = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) return;
    setFilterHistory(prev => {
      const newHistory = [trimmed, ...prev.filter(item => item !== trimmed)].slice(0, 10);
      localStorage.setItem('filterHistory', JSON.stringify(newHistory));
      return newHistory;
    });
  };

  const refreshImageList = (dbName: string) => {
    setStatus('loading');
    console.log('Fetching images for dataset:', dbName);
    apiClient
      .post('/api/datasets/listImages', { datasetName: dbName })
      .then((res: any) => {
        const data = res.data;
        console.log('Images:', data.images);
        // sort
        data.images.sort((a: { img_path: string }, b: { img_path: string }) => a.img_path.localeCompare(b.img_path));
        setImgList(data.images);
        setStatus('success');
      })
      .catch(error => {
        console.error('Error fetching images:', error);
        setStatus('error');
      });
  };

  const { captionCount, totalCount } = useMemo(() => {
    return {
      captionCount: imgList.filter(img => img.caption && img.caption.trim().length > 0).length,
      totalCount: imgList.length,
    };
  }, [imgList]);

  const filteredImgList = useMemo(() => {
    if (!filter) return imgList;

    const lowerFilter = filter.toLowerCase();

    // Helper to escape regex special characters
    const escapeRegExp = (string: string) => {
      return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    };

    const matchesTerm = (caption: string, term: string) => {
      term = term.trim();
      if (!term) return true;

      // Check if term is quoted
      if (term.startsWith('"') && term.endsWith('"')) {
        const exactTerm = term.slice(1, -1);
        if (!exactTerm) return true;
        // Whole word search using regex with word boundaries
        // Ensure we support Unicode word boundaries if needed, 
        // but for "he" standard \b should work unless there are punctuation issues
        const regex = new RegExp(`(^|[^a-zA-Z0-9_])${escapeRegExp(exactTerm)}([^a-zA-Z0-9_]|$)`, 'i');
        return regex.test(caption);
      }

      // Default partial match
      return caption.toLowerCase().includes(term.toLowerCase());
    };

    // Function to split by operator while respecting quotes
    const splitByOperator = (input: string, operator: 'and' | 'or') => {
      const regex = new RegExp(`\\s+${operator}\\s+`, 'gi');
      const parts: string[] = [];
      let lastIndex = 0;
      let match;

      while ((match = regex.exec(input)) !== null) {
        const part = input.slice(lastIndex, match.index).trim();
        // Only split if we're not inside quotes
        const quoteCount = (part.match(/"/g) || []).length;
        if (quoteCount % 2 === 0) {
          parts.push(part);
          lastIndex = regex.lastIndex;
        }
      }
      parts.push(input.slice(lastIndex).trim());
      return parts.filter(p => p !== '');
    };

    // support OR and AND
    // if there is an OR, split by OR and check if any part matches
    const orParts = splitByOperator(filter, 'or');
    if (orParts.length > 1) {
      return imgList.filter(img => {
        const caption = img.caption || '';
        return orParts.some(part => {
          // even in OR parts, there might be ANDs
          const andParts = splitByOperator(part, 'and');
          if (andParts.length > 1) {
            return andParts.every(subPart => matchesTerm(caption, subPart));
          }
          return matchesTerm(caption, part);
        });
      });
    }

    // if there is an AND, split by AND and check if all parts match
    const andParts = splitByOperator(filter, 'and');
    if (andParts.length > 1) {
      return imgList.filter(img => {
        const caption = img.caption || '';
        return andParts.every(part => matchesTerm(caption, part));
      });
    }

    // default simple search
    return imgList.filter(img => matchesTerm(img.caption || '', filter));
  }, [imgList, filter]);
  useEffect(() => {
    if (datasetName) {
      refreshImageList(datasetName);
    }
  }, [datasetName]);

  const PageInfoContent = useMemo(() => {
    let icon = null;
    let text = '';
    let subtitle = '';
    let showIt = false;
    let bgColor = '';
    let textColor = '';
    let iconColor = '';

    if (status == 'loading') {
      icon = <LuLoader className="animate-spin w-8 h-8" />;
      text = 'Loading Images';
      subtitle = 'Please wait while we fetch your dataset images...';
      showIt = true;
      bgColor = 'bg-gray-50 dark:bg-gray-800/50';
      textColor = 'text-gray-900 dark:text-gray-100';
      iconColor = 'text-gray-500 dark:text-gray-400';
    }
    if (status == 'error') {
      icon = <LuBan className="w-8 h-8" />;
      text = 'Error Loading Images';
      subtitle = 'There was a problem fetching the images. Please try refreshing the page.';
      showIt = true;
      bgColor = 'bg-red-50 dark:bg-red-950/20';
      textColor = 'text-red-900 dark:text-red-100';
      iconColor = 'text-red-600 dark:text-red-400';
    }
    if (status == 'success' && imgList.length === 0) {
      icon = <LuImageOff className="w-8 h-8" />;
      text = 'No Images Found';
      subtitle = 'This dataset is empty. Click "Add Images" to get started.';
      showIt = true;
      bgColor = 'bg-gray-50 dark:bg-gray-800/50';
      textColor = 'text-gray-900 dark:text-gray-100';
      iconColor = 'text-gray-500 dark:text-gray-400';
    }

    if (status == 'success' && imgList.length > 0 && filteredImgList.length === 0) {
      icon = <LuImageOff className="w-8 h-8" />;
      text = 'No Matches';
      subtitle = `No images match your filter: "${filter}"`;
      showIt = true;
      bgColor = 'bg-gray-50 dark:bg-gray-800/50';
      textColor = 'text-gray-900 dark:text-gray-100';
      iconColor = 'text-gray-500 dark:text-gray-400';
    }

    if (!showIt) return null;

    return (
      <div
        className={`mt-10 flex flex-col items-center justify-center py-16 px-8 rounded-xl border-2 border-gray-700 border-dashed ${bgColor} ${textColor} mx-auto max-w-md text-center`}
      >
        <div className={`${iconColor} mb-4`}>{icon}</div>
        <h3 className="text-lg font-semibold mb-2">{text}</h3>
        <p className="text-sm opacity-75 leading-relaxed">{subtitle}</p>
      </div>
    );
  }, [status, imgList.length, filteredImgList.length, filter]);

  return (
    <>
      {/* Fixed top bar */}
      <TopBar>
        <div>
          <Button className="text-gray-500 dark:text-gray-300 px-3 mt-1" onClick={() => history.back()}>
            <FaChevronLeft />
          </Button>
        </div>
        <div>
          <h1 className="text-lg">Dataset: {datasetName}</h1>
        </div>
        <div className="flex-1 max-w-xl mx-4 relative">
          <input
            type="text"
            className="w-full bg-slate-800 border border-slate-700 rounded-md px-3 py-1 text-sm text-gray-200 focus:outline-none focus:ring-1 focus:ring-slate-500"
            placeholder="Filter by caption (supports AND, OR)..."
            value={filter}
            onChange={e => setFilter(e.target.value)}
            onFocus={() => setShowHistory(true)}
            onBlur={() => {
              // Delay hiding to allow clicking on history items
              setTimeout(() => setShowHistory(false), 200);
              addToHistory(filter);
            }}
            onKeyDown={e => {
              if (e.key === 'Enter') {
                addToHistory(filter);
                (e.target as HTMLInputElement).blur();
              }
            }}
          />
          {showHistory && filterHistory.length > 0 && (
            <div className="absolute top-full left-0 w-full mt-1 bg-slate-800 border border-slate-700 rounded-md shadow-lg z-50 max-h-60 overflow-y-auto">
              {filterHistory.map((item, index) => (
                <div
                  key={index}
                  className="px-3 py-2 text-sm text-gray-200 hover:bg-slate-700 cursor-pointer"
                  onClick={() => {
                    setFilter(item);
                    setShowHistory(false);
                  }}
                >
                  {item}
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="flex-1"></div>
        {status === 'success' && totalCount > 0 && (
          <div className="text-sm text-gray-400 mr-4">
            Caption count: {captionCount}/{totalCount}
          </div>
        )}
        <div>
          <Button
            className="text-gray-200 bg-slate-600 px-3 py-1 rounded-md"
            onClick={() => openImagesModal(datasetName, () => refreshImageList(datasetName))}
          >
            Add Images
          </Button>
        </div>
      </TopBar>
      <MainContent>
        {PageInfoContent}
        {status === 'success' && filteredImgList.length > 0 && (
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
            {filteredImgList.map(img => (
              <DatasetImageCard
                key={img.img_path}
                alt="image"
                imageUrl={img.img_path}
                onDelete={() => refreshImageList(datasetName)}
                onCaptionSave={(newCaption, imgPath) => {
                  setImgList(prev =>
                    prev.map(item => (item.img_path === imgPath ? { ...item, caption: newCaption } : item)),
                  );
                }}
                initialCaption={img.caption}
              />
            ))}
          </div>
        )}
      </MainContent>
      <AddImagesModal />
      <FullscreenDropOverlay
        datasetName={datasetName}
        onComplete={() => refreshImageList(datasetName)}
      />
    </>
  );
}
