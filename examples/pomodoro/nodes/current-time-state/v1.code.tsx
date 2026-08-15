import { useEffect, useRef } from 'react';
import useCurrentTimePoller from '@nodes/current-time-poller/useCurrentTimePoller';

export function useCurrentTimeState() {
  const currentTime = useCurrentTimePoller();
  return currentTime;
}

type StartTimeActionProps = {
  callback: () => void;
};

export function useStartTimeAction({ callback }: StartTimeActionProps) {
  React.useEffect(() => {
    if (callback && typeof startTime === 'function') {
      callback();
    }
  }, [startTime, callback]);
}

export function useStopTimeAction({ callback }: StopTimeActionProps) {
  useEffect(() => {
    if (callback && typeof stopTime === 'function') {
      callback();
    }
  }, [stopTime, callback]);
}