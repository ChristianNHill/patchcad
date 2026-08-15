import React from 'react';

const useButtonContainerLogicController = () => {
  // Example implementation of the button container logic controller
  const [workMinutes, setWorkMinutes] = React.useState(25);
  const [breakMinutes, setBreakMinutes] = React.useState(5);
  const [sessionCount, setSessionCount] = React.useState(0);
  const [timerRunning, setTimerRunning] = React.useState(false);
  const [timeLeft, setTimeLeft] = React.useState(workMinutes * 60);

  const startTimer = () => {
    setTimerRunning(true);
    const interval = setInterval(() => {
      setTimeLeft(prevTime => prevTime - 1);
      if (prevTime <= 0) {
        clearInterval(interval);
        setSessionCount(prevSession => prevSession + 1);
        // Logic to switch between work and break
        if (timeLeft === workMinutes * 60) {
          setTimeLeft(breakMinutes * 60);
        } else {
          setTimeLeft(workMinutes * 60);
        }
      }
    }, 1000);
  };

  const stopTimer = () => {
    setTimerRunning(false);
    clearInterval(interval);
  };

  const resetTimer = () => {
    setTimerRunning(false);
    setTimeLeft(workMinutes * 60);
    sessionCount(0);
  };

  return {
    workMinutes,
    setWorkMinutes,
    breakMinutes,
    setBreakMinutes,
    sessionCount,
    timeLeft,
    startTimer,
    stopTimer,
    resetTimer
  };
};

export { useButtonContainerLogicController };
