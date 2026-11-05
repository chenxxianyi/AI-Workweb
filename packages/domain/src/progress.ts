/** 自动进度按有效任务计算；手动0%必须保留。 */
export function projectProgress(manual:boolean,manualProgress:number|null,total:number,done:number):number {
  return manual?(manualProgress??0):total===0?0:Math.round(done/total*100);
}
