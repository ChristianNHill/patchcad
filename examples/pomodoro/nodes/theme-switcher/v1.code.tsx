import { usePatchcadParam } from '@patchcad/preview-runtime';

const ThemeSwitcher = () => {
  const theme = usePatchcadParam('theme-switcher', 'theme', 'light');

  return (
    <style jsx>{`
      body {
        background-color: ${theme === 'dark' ? '#333' : '#fff'};
        color: ${theme === 'dark' ? '#fff' : '#333'};
      }
    `}</style>
  );
};

export { ThemeSwitcher };