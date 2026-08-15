import React, { useState, useEffect } from 'react';
import { usePatchcadParam } from '@patchcad/preview-runtime';
import { TimeDisplay } from '@nodes/time-display';

const pomodoroRoot = () => {
  const workMinutes = usePatchcadParam('pomodoro-root', 'workMinutes', 25);
  const breakMinutes = usePatchcadParam('pomodoro-root', 'breakMinutes', 5);

  const [currentTimer, setCurrentTimer] = useState(workMinutes * 60);
  const [isRunning, setIsRunning] = useState(false);
  const [sessions, setSessions] = useState(0);

  useEffect(() => {
    let interval: NodeJS.Timeout;
    if (isRunning && currentTimer > 0) {
      interval = setInterval(() => {
        setCurrentTimer(prevTime => prevTime - 1);
      }, 1000);
    } else if (!isRunning && currentTimer === 0) {
      clearInterval(interval);
      setSessions(prevSessions => prevSessions + 1);
      setCurrentTimer(breakMinutes * 60);
      setIsRunning(true);
    }

    return () => clearInterval(interval);
  }, [isRunning, currentTimer, breakMinutes]);

  const startPause = () => {
    setIsRunning(prevIsRunning => !prevIsRunning);
  };

  return (
    <div style={{ padding: '1rem' }}>
      <h1>Pomodoro Timer</h1>
      <TimeDisplay time={Math.floor(currentTimer / 60)} />
      <button onClick={startPause}>
        {isRunning ? 'Pause' : 'Start'}
      </button>
      <p>Sessions: {sessions}</p>
    </div>
  );
};

export { pomodoroRoot };