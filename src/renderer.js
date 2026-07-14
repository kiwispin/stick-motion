export function renderDocument({ context, width, height, backgroundImage, figures, showHandles = false, drawFigure }) {
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, width, height);
  if (backgroundImage) context.drawImage(backgroundImage, 0, 0, width, height);
  figures.forEach(figure => {
    figure.updatePositions();
    drawFigure(figure, showHandles);
  });
}
