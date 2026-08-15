import React, { useState, useEffect } from 'react';
import { usePatchcadParam } from '@patchcad/preview-runtime';

const useLogicController = () => {
  const [workMinutes, setWorkMinutes] = useState<number>(usePatchcadParam('@node/logic-controller', 'workMinutes', 25));
  const [breakMinutes, setBreakMinutes] = useState<number>(usePatchcadParam('@node/logic-controller', 'breakMinutes', 5));
  const [sessionCount, setSessionCount] = useState<number>(0);

  let timer: any;

  const startTimerLogic = () => {
    if (timer) clearInterval(timer);
    let timeLeft = workMinutes * 60;
    let isWorking = true;

    timer = setInterval(() => {
      if (timeLeft > 0) {
        timeLeft -= 1;
        setSessionCount(isWorking ? sessionCount : sessionCount + 1);
      } else {
        clearInterval(timer);
        alert(isWorking ? 'Break time!' : 'Work time!');
        isWorking = !isWorking;
        startTimerLogic();
      }
    }, 1000);
  };

  const stopTimerLogic = () => {
    clearInterval(timer);
  };

  useEffect(() => {
    setWorkMinutes(usePatchcadParam('@node/logic-controller', 'workMinutes', 25));
    setBreakMinutes(usePatchcadParam('@node/logic-controller', 'breakMinutes', 5));
    setSessionCount(0);
  }, []);

  return {
    workMinutes,
    breakMinutes,
    sessionCount,
    startTimerLogic,
    stopTimerLogic,
  };
};

export { useLogicController, startTimerLogic as defaultStartTimerLogic, stopTimerLogic as defaultStopTimerLogic };