import React, { useState } from 'react';

export function useButtonContainerLogicController({ startTimer, stopTimer, resetTimer }) {
  const [isRunning, setIsRunning] = useState(false);
  const [workMinutes, setWorkMinutes] = useState(25);
  const [breakMinutes, setBreakMinutes] = useState(5);
  const [sessionCount, setSessionCount] = useState(0);

  const handleStartClick = () => {
    setIsRunning(true);
    startTimer(workMinutes * 60);
  };

  const handleStopClick = () => {
    setIsRunning(false);
    stopTimer();
  };

  const handleResetClick = () => {
    setIsRunning(false);
    resetTimer();
    setSessionCount(sessionCount + 1);
  };

  return {
    isRunning,
    workMinutes,
    breakMinutes,
    sessionCount,
    handleStartClick,
    handleStopClick,
    handleResetClick,
  };
}
