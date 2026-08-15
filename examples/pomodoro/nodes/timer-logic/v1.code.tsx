import { usePatchcadParam } from '@patchcad/preview-runtime';

const TimerLogic = () => {
  const workMinutes = usePatchcadParam('timer-logic', 'workMinutes', 25);
  const breakMinutes = usePatchcadParam('timer-logic', 'breakMinutes', 5);
  let timerId: NodeJS.Timeout | null = null;

  const startTimerLogic = () => {
    if (timerId) return;
    const startWork = () => {
      console.log('Working...');
      setSessionCounter(prev => prev + 1);
      startBreak();
    };

    const startBreak = () => {
      setTimeout(() => {
        console.log('Break time!');
        startWork();
      }, breakMinutes * 60 * 1000);
    };

    startWork();
  };

  const stopTimerLogic = () => {
    if (timerId) {
      clearInterval(timerId);
      timerId = null;
      console.log('Timer stopped.');
    }
  };

  return {
    startTimerLogic,
    stopTimerLogic,
  };
};

export { startTimerLogic, stopTimerLogic };